import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { Passkey } from "../models/Passkey.js";
import { PasskeyChallenge } from "../models/PasskeyChallenge.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { sendMail } from "../utils/mailer.js";
import { emailFor } from "../utils/emailText.js";
import { isAllowedOrigin, primaryClientUrl } from "../utils/origins.js";
import { checkLine } from "../utils/profileFields.js";
import { toPublicUser } from "../utils/serialize.js";
import { startSession } from "../services/sessions.js";
import { checkSecondStep } from "../services/twoFactor.js";

// Passkeys: signing in with a key kept on the person's own device, unlocked by their fingerprint, face or PIN. The site holds only the public
// half. Mounted under /api/auth.
//
//   - It resists the thing passwords and one-time codes don't: the browser only offers a passkey to the site it was made for, so a fake login
//     page gets nothing to steal. Because the device checks the person too, a passkey counts as both "something you have" and "something you
//     are", so it is accepted INSTEAD of the password and the two-step code, not as a third thing on top.
//   - It must not become a hidden back door. Adding one needs the password (and a code, with two-step sign-in), the owner is emailed when one
//     is added or removed, and anything that is done to take an account back (resetting the password by email, undoing an email change)
//     removes every passkey, since someone who got in could have added one.
export const passkeysRouter = Router();

const RP_NAME = "CreativesSelect";
const FIFTEEN_MIN = 15 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS = 10;
const ALGORITHMS = [-7, -257]; // ES256 and RS256: what phones, computers and password managers all support

const passwordFails = createLimiter({ name: "passkey-password", limit: 5, windowMs: FIFTEEN_MIN });
const codeFails = createLimiter({ name: "passkey-code", limit: 5, windowMs: FIFTEEN_MIN });
const registrationsPerHour = createLimiter({ name: "passkey-register", limit: 10, windowMs: 60 * 60 * 1000 });
const loginOptionsByIp = createLimiter({ name: "passkey-login-options", limit: 60, windowMs: FIFTEEN_MIN });
const loginFailsByIp = createLimiter({ name: "passkey-login-fail", limit: 20, windowMs: FIFTEEN_MIN });

/**
 * The domain a passkey belongs to. A passkey made for one domain is never offered by the browser on another, which is the point, so this
 * is the site's main address (or PASSKEY_RP_ID if set). Someone on a different address of the site (such as the original *.vercel.app one)
 * simply can't use passkeys, and the page says so.
 */
export function rpId() {
  return process.env.PASSKEY_RP_ID || new URL(primaryClientUrl()).hostname;
}

/** The origin the browser reported, if it is one of the site's own and a place this passkey domain is valid for. */
function expectedOrigin(req) {
  const origin = req.get("origin") || primaryClientUrl();
  if (!isAllowedOrigin(origin)) return null;
  const host = new URL(origin).hostname;
  return host === rpId() || host.endsWith(`.${rpId()}`) ? origin : null;
}

const tooMany = (res, seconds) => {
  res.set("Retry-After", String(seconds));
  return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
};
const serverError = (res, err) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
const WRONG_ORIGIN = () => ({ error: `Passkeys work on ${rpId()} only. Open the site there to use them.`, code: "passkey_wrong_site" });
const FAILED = { error: "That passkey didn't work. Try again, or sign in with your password." };

function notify(user, kind, keyName) {
  sendMail({ to: user.email, ...emailFor(kind, user, { name: user.displayName, keyName }) }).catch((err) => console.error("Passkey notice failed:", err.message));
}

/** The random value inside what the browser sent back, which names the challenge we gave it. */
function challengeOf(response) {
  try {
    const json = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON), "base64url").toString("utf8"));
    return typeof json.challenge === "string" && json.challenge.length <= 200 ? json.challenge : null;
  } catch {
    return null;
  }
}

/** A challenge is used once: taking it out is what claims it. */
async function claimChallenge(response, purpose, user = null) {
  const challenge = challengeOf(response);
  if (!challenge) return null;
  const row = await PasskeyChallenge.findOneAndDelete({ challenge, purpose, user, expireAt: { $gt: new Date() } });
  return row ? challenge : null;
}

const show = (p) => ({ id: String(p._id), name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, synced: p.deviceType === "multiDevice", backedUp: p.backedUp });
const responseSchema = z.object({ id: z.string().min(1).max(1400), rawId: z.string().max(1400), response: z.record(z.string(), z.unknown()), type: z.literal("public-key"), clientExtensionResults: z.record(z.string(), z.unknown()).optional(), authenticatorAttachment: z.string().max(40).optional() }).passthrough();
const askSchema = z.object({ password: z.string().min(1).max(200), code: z.string().max(40).optional() });

passkeysRouter.get("/passkeys", requireAuth, async (req, res) => {
  try {
    const keys = await Passkey.find({ user: req.user.id }).sort({ createdAt: 1 });
    res.json({ passkeys: keys.map(show), rpId: rpId(), max: MAX_PASSKEYS });
  } catch (err) {
    serverError(res, err);
  }
});

// Step one of adding one. The password is asked for again (and a code, with two-step sign-in): a stolen session alone must not be able to
// leave a key behind that outlives a password change.
passkeysRouter.post("/passkeys/register/options", requireAuth, async (req, res) => {
  try {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your password" });
    if (!expectedOrigin(req)) return res.status(400).json(WRONG_ORIGIN());
    if (await passwordFails.isLimited(req.user.id)) return tooMany(res, passwordFails.windowSeconds);
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (!(await user.comparePassword(parsed.data.password))) {
      await passwordFails.hit(req.user.id);
      return res.status(403).json({ error: "That password isn't right" });
    }
    if (user.twoFactor?.enabled) {
      if (await codeFails.isLimited(req.user.id)) return tooMany(res, codeFails.windowSeconds);
      if (!parsed.data.code || !(await checkSecondStep(user, parsed.data.code))) {
        await codeFails.hit(req.user.id);
        return res.status(401).json({ error: "Enter a code from your authenticator app (or a recovery code) to add a passkey", code: "second_step_needed" });
      }
    }
    const existing = await Passkey.find({ user: user._id }).select("credentialId transports");
    if (existing.length >= MAX_PASSKEYS) return res.status(400).json({ error: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` });
    if (!(await registrationsPerHour.allow(req.user.id))) return tooMany(res, registrationsPerHour.windowSeconds);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId(),
      userName: user.username,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(String(user._id)),
      attestationType: "none", // the site doesn't ask which make of device it is
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
      timeout: CHALLENGE_MS,
    });
    await PasskeyChallenge.create({ challenge: options.challenge, purpose: "register", user: user._id, expireAt: new Date(Date.now() + CHALLENGE_MS) });
    res.json(options);
  } catch (err) {
    serverError(res, err);
  }
});

passkeysRouter.post("/passkeys/register/verify", requireAuth, async (req, res) => {
  try {
    const parsed = z.object({ response: responseSchema, name: z.string().max(100).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json(FAILED);
    const origin = expectedOrigin(req);
    if (!origin) return res.status(400).json(WRONG_ORIGIN());
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    const challenge = await claimChallenge(parsed.data.response, "register", user._id);
    if (!challenge) return res.status(400).json({ error: "That took too long. Start again.", code: "challenge_expired" });

    let info;
    try {
      const result = await verifyRegistrationResponse({ response: parsed.data.response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId(), requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS });
      if (!result.verified) return res.status(400).json(FAILED);
      info = result.registrationInfo;
    } catch {
      return res.status(400).json(FAILED);
    }
    if ((await Passkey.countDocuments({ user: user._id })) >= MAX_PASSKEYS) return res.status(400).json({ error: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` });

    const checked = parsed.data.name ? checkLine(parsed.data.name, 40, "The name") : { value: "" };
    if (checked.error) return res.status(400).json({ error: checked.error });
    const count = await Passkey.countDocuments({ user: user._id });
    let key;
    try {
      key = await Passkey.create({
        user: user._id,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: info.credential.counter,
        transports: (info.credential.transports ?? []).slice(0, 8),
        name: checked.value || `Passkey ${count + 1}`,
        deviceType: info.credentialDeviceType,
        backedUp: Boolean(info.credentialBackedUp),
      });
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: "That passkey is already registered." });
      throw err;
    }
    notify(user, "passkeyAdded", key.name);
    res.status(201).json({ passkey: show(key) });
  } catch (err) {
    serverError(res, err);
  }
});

// Signing in. Nobody is known yet, so the options name no one: the device offers whichever passkey it holds for this site.
passkeysRouter.post("/passkeys/login/options", async (req, res) => {
  try {
    if (!expectedOrigin(req)) return res.status(400).json(WRONG_ORIGIN());
    if (!(await loginOptionsByIp.allow(clientIp(req)))) return tooMany(res, loginOptionsByIp.windowSeconds);
    const options = await generateAuthenticationOptions({ rpID: rpId(), userVerification: "required", timeout: CHALLENGE_MS });
    await PasskeyChallenge.create({ challenge: options.challenge, purpose: "login", user: null, expireAt: new Date(Date.now() + CHALLENGE_MS) });
    res.json(options);
  } catch (err) {
    serverError(res, err);
  }
});

passkeysRouter.post("/passkeys/login/verify", async (req, res) => {
  try {
    const parsed = z.object({ response: responseSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json(FAILED);
    const origin = expectedOrigin(req);
    if (!origin) return res.status(400).json(WRONG_ORIGIN());
    if (await loginFailsByIp.isLimited(clientIp(req))) return tooMany(res, loginFailsByIp.windowSeconds);
    const failed = async (status = 401) => {
      await loginFailsByIp.hit(clientIp(req));
      return res.status(status).json(FAILED);
    };

    const response = parsed.data.response;
    const challenge = await claimChallenge(response, "login", null);
    if (!challenge) return failed();
    const key = await Passkey.findOne({ credentialId: response.id });
    const user = key ? await User.findById(key.user) : null;
    if (!key || !user) return failed();
    // The device also says which account the key was made for; it has to agree.
    const handle = response.response?.userHandle;
    if (typeof handle === "string" && handle && Buffer.from(handle, "base64url").toString("utf8") !== String(user._id)) return failed();

    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId(),
        requireUserVerification: true,
        credential: { id: key.credentialId, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports },
      });
    } catch {
      return failed();
    }
    if (!result.verified) return failed();
    // Said only after a real passkey answered, so it can't be used to find out which accounts are suspended.
    if (user.suspendedAt) return res.status(403).json({ error: "This account has been suspended. If you think that is a mistake, contact the site's team.", code: "account_suspended" });

    // The counter is moved on in the same step that checks it hasn't moved, so one answer can't be used twice at once.
    const advanced = await Passkey.updateOne({ _id: key._id, counter: key.counter }, { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date(), backedUp: result.authenticationInfo.credentialBackedUp });
    if (advanced.modifiedCount !== 1 && !(key.counter === 0 && result.authenticationInfo.newCounter === 0)) return failed();

    await startSession(req, res, user, { notify: true });
    res.json({ user: await toPublicUser(user, user._id) });
  } catch (err) {
    serverError(res, err);
  }
});

const nameSchema = z.object({ name: z.string().min(1).max(100) });
passkeysRouter.patch("/passkeys/:id", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "That passkey wasn't found" });
    const parsed = nameSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Give it a name" });
    const checked = checkLine(parsed.data.name, 40, "The name");
    if (checked.error || !checked.value) return res.status(400).json({ error: checked.error || "Give it a name" });
    const key = await Passkey.findOneAndUpdate({ _id: req.params.id, user: req.user.id }, { name: checked.value }, { new: true });
    if (!key) return res.status(404).json({ error: "That passkey wasn't found" });
    res.json({ passkey: show(key) });
  } catch (err) {
    serverError(res, err);
  }
});

passkeysRouter.delete("/passkeys/:id", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "That passkey wasn't found" });
    const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your password" });
    if (await passwordFails.isLimited(req.user.id)) return tooMany(res, passwordFails.windowSeconds);
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (!(await user.comparePassword(parsed.data.password))) {
      await passwordFails.hit(req.user.id);
      return res.status(403).json({ error: "That password isn't right" });
    }
    const key = await Passkey.findOneAndDelete({ _id: req.params.id, user: user._id });
    if (!key) return res.status(404).json({ error: "That passkey wasn't found" });
    notify(user, "passkeyRemoved", key.name);
    res.status(204).end();
  } catch (err) {
    serverError(res, err);
  }
});
