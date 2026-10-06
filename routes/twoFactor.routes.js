import { Router } from "express";
import { z } from "zod";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { sendMail } from "../utils/mailer.js";
import { seal, open } from "../utils/secretBox.js";
import { toPublicUser } from "../utils/serialize.js";
import { generateRecoveryCodes, generateSecret, hashRecoveryCode, matchStep, otpauthUrl } from "../utils/totp.js";
import { startSession } from "../services/sessions.js";
import { checkSecondStep, userForChallenge } from "../services/twoFactor.js";

// Two-step sign-in: after the password, a code from an authenticator app (or a one-time recovery code). Mounted under /api/auth.
export const twoFactorRouter = Router();

const FIFTEEN_MIN = 15 * 60 * 1000;
const ISSUER = "CreativesSelect";
// Wrong codes are counted per person (so many addresses can't be used to guess at one account) and per address.
const codeFailsByUser = createLimiter({ name: "two-step-code", limit: 5, windowMs: FIFTEEN_MIN });
const codeFailsByIp = createLimiter({ name: "two-step-code-ip", limit: 30, windowMs: FIFTEEN_MIN });
const passwordFails = createLimiter({ name: "two-step-password", limit: 5, windowMs: FIFTEEN_MIN });

const tooMany = (res, seconds) => {
  res.set("Retry-After", String(seconds));
  return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
};
const serverError = (res, err) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

const passwordSchema = z.object({ password: z.string().min(1).max(200) });
const codeSchema = z.object({ code: z.string().min(1).max(40) });
const loginSchema = z.object({ challenge: z.string().min(1).max(2000), code: z.string().min(1).max(40) });
const passwordAndCodeSchema = passwordSchema.merge(codeSchema);

function notify(user, subject, line) {
  sendMail({ to: user.email, subject, text: `Hi ${user.displayName},\n\n${line}\n\nIf that wasn't you, change your password right away and sign out other devices from your profile settings.` }).catch((err) => console.error("Two-step notice failed:", err.message));
}

const newRecoveryCodes = () => {
  const codes = generateRecoveryCodes();
  return { codes, hashes: codes.map(hashRecoveryCode) };
};

/** The signed-in person, if the password is right (counted and limited like every other place a password is asked for). */
async function userWithPassword(req, res, password) {
  if (await passwordFails.isLimited(req.user.id)) {
    tooMany(res, passwordFails.windowSeconds);
    return null;
  }
  const user = await User.findById(req.user.id);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  if (!(await user.comparePassword(password))) {
    await passwordFails.hit(req.user.id);
    res.status(403).json({ error: "That password isn't right" });
    return null;
  }
  return user;
}

/** Checks the second step with the limits applied; sends the refusal itself and returns false if it isn't right. */
async function secondStepOk(req, res, user, code) {
  if ((await codeFailsByUser.isLimited(String(user._id))) || (await codeFailsByIp.isLimited(clientIp(req)))) {
    tooMany(res, codeFailsByUser.windowSeconds);
    return false;
  }
  if (await checkSecondStep(user, code)) return true;
  await Promise.all([codeFailsByUser.hit(String(user._id)), codeFailsByIp.hit(clientIp(req))]);
  res.status(401).json({ error: "That code didn't work. Check the code in your app, or use a recovery code." });
  return false;
}

// Finishes a sign-in that the password started (see the login route): the note from login plus a right code.
twoFactorRouter.post("/login/2fa", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter the code from your authenticator app" });
    const user = await userForChallenge(parsed.data.challenge);
    if (!user) return res.status(401).json({ error: "That sign-in took too long — please log in again.", code: "challenge_expired" });
    if (!(await secondStepOk(req, res, user, parsed.data.code))) return;
    await startSession(req, res, user);
    const fresh = await User.findById(user._id);
    res.status(200).json({ user: await toPublicUser(fresh, fresh._id), recoveryCodesLeft: fresh.twoFactor.recoveryHashes.length });
  } catch (err) {
    serverError(res, err);
  }
});

twoFactorRouter.get("/2fa", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("twoFactor");
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    res.json({ enabled: Boolean(user.twoFactor?.enabled), recoveryCodesLeft: user.twoFactor?.enabled ? user.twoFactor.recoveryHashes.length : 0 });
  } catch (err) {
    serverError(res, err);
  }
});

// Step one of turning it on: a fresh secret, kept aside (sealed) until a code from the app proves it was added.
twoFactorRouter.post("/2fa/setup", requireAuth, async (req, res) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your password" });
    const user = await userWithPassword(req, res, parsed.data.password);
    if (!user) return;
    if (user.twoFactor?.enabled) return res.status(409).json({ error: "Two-step sign-in is already on" });
    const secret = generateSecret();
    await User.updateOne({ _id: user._id }, { $set: { "twoFactor.pendingSecret": seal(secret) } });
    res.json({ secret, otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: ISSUER }) });
  } catch (err) {
    serverError(res, err);
  }
});

// Step two: the app's first code. Only now is it on, and the recovery codes are shown, once.
twoFactorRouter.post("/2fa/enable", requireAuth, async (req, res) => {
  try {
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter the 6-digit code from your app" });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (user.twoFactor?.enabled) return res.status(409).json({ error: "Two-step sign-in is already on" });
    if (!user.twoFactor?.pendingSecret) return res.status(400).json({ error: "Start again: ask for a new setup key first" });
    if (await codeFailsByUser.isLimited(String(user._id))) return tooMany(res, codeFailsByUser.windowSeconds);
    let step = null;
    try {
      step = matchStep(open(user.twoFactor.pendingSecret), parsed.data.code.replace(/\s/g, ""));
    } catch {
      step = null;
    }
    if (step === null) {
      await codeFailsByUser.hit(String(user._id));
      return res.status(400).json({ error: "That code didn't match. Check the code in your app and try again." });
    }
    const { codes, hashes } = newRecoveryCodes();
    const turnedOn = await User.updateOne(
      { _id: user._id, "twoFactor.enabled": false, "twoFactor.pendingSecret": user.twoFactor.pendingSecret },
      { $set: { "twoFactor.enabled": true, "twoFactor.secret": user.twoFactor.pendingSecret, "twoFactor.pendingSecret": null, "twoFactor.lastStep": step, "twoFactor.recoveryHashes": hashes, "twoFactor.enabledAt": new Date() } }
    );
    if (turnedOn.modifiedCount !== 1) return res.status(409).json({ error: "Two-step sign-in is already on" });
    notify(user, "Two-step sign-in was turned on", "Two-step sign-in was just turned on for your CreativesSelect account. From now on, logging in needs a code from your authenticator app.");
    res.json({ recoveryCodes: codes });
  } catch (err) {
    serverError(res, err);
  }
});

twoFactorRouter.post("/2fa/disable", requireAuth, async (req, res) => {
  try {
    const parsed = passwordAndCodeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your password and a code" });
    const user = await userWithPassword(req, res, parsed.data.password);
    if (!user) return;
    if (!user.twoFactor?.enabled) return res.status(400).json({ error: "Two-step sign-in isn't on" });
    if (!(await secondStepOk(req, res, user, parsed.data.code))) return;
    await User.updateOne({ _id: user._id }, { $set: { twoFactor: { enabled: false, secret: null, pendingSecret: null, lastStep: 0, recoveryHashes: [], enabledAt: null } } });
    notify(user, "Two-step sign-in was turned off", "Two-step sign-in was just turned off for your CreativesSelect account.");
    res.status(204).end();
  } catch (err) {
    serverError(res, err);
  }
});

// New recovery codes (the old ones stop working), for someone who has used some or lost the list.
twoFactorRouter.post("/2fa/recovery-codes", requireAuth, async (req, res) => {
  try {
    const parsed = passwordAndCodeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your password and a code" });
    const user = await userWithPassword(req, res, parsed.data.password);
    if (!user) return;
    if (!user.twoFactor?.enabled) return res.status(400).json({ error: "Two-step sign-in isn't on" });
    if (!(await secondStepOk(req, res, user, parsed.data.code))) return;
    const { codes, hashes } = newRecoveryCodes();
    await User.updateOne({ _id: user._id }, { $set: { "twoFactor.recoveryHashes": hashes } });
    res.json({ recoveryCodes: codes });
  } catch (err) {
    serverError(res, err);
  }
});
