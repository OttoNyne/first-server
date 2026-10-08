import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { User } from "../models/User.js";
import { EmailChange } from "../models/EmailChange.js";
import { EmailVerification } from "../models/EmailVerification.js";
import { PasswordReset } from "../models/PasswordReset.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { mailAvailable, sendMail } from "../utils/mailer.js";
import { emailFor } from "../utils/emailText.js";
import { maskEmail } from "../utils/maskEmail.js";
import { primaryClientUrl } from "../utils/origins.js";
import { hashToken } from "../services/emailVerification.js";
import { checkSecondStep } from "../services/twoFactor.js";
import { endAllSessions } from "../services/sessions.js";
import { Passkey } from "../models/Passkey.js";

// Changing the address the account is tied to (it is where password-reset links go, so it is as sensitive as the password). Mounted under /api/auth.
//
//   1. POST /email/change   the signed-in person gives the new address, their password (and a code, if they use two-step sign-in).
//                           A link goes to the NEW address; a notice goes to the OLD one. Nothing has changed yet.
//   2. POST /email/confirm  the link from the new address. Now the account's email changes (and counts as confirmed). A notice with an
//                           "undo" link goes to the OLD address.
//   3. POST /email/revert   the undo link, good for a week. Puts the old address back, signs every device out and cancels any password
//                           reset in flight, so someone who got in and moved the address can be shut out by the real owner.
export const emailChangeRouter = Router();

const FIFTEEN_MIN = 15 * 60 * 1000;
const PENDING_MS = 60 * 60 * 1000;
const REVERT_MS = 7 * 24 * 60 * 60 * 1000;
const passwordFails = createLimiter({ name: "email-change-password", limit: 5, windowMs: FIFTEEN_MIN });
const codeFails = createLimiter({ name: "email-change-code", limit: 5, windowMs: FIFTEEN_MIN });
const requestsPerHour = createLimiter({ name: "email-change-request", limit: 3, windowMs: 60 * 60 * 1000 });
const linkFails = createLimiter({ name: "email-change-link", limit: 20, windowMs: FIFTEEN_MIN });

const requestSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
  code: z.string().max(40).optional(),
});
const tokenSchema = z.object({ token: z.string().min(20).max(200) });

const tooMany = (res, seconds) => {
  res.set("Retry-After", String(seconds));
  return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
};
const serverError = (res, err) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
const baseUrl = () => (process.env.CLIENT_URL ? primaryClientUrl() : "http://localhost:5173");
const send = (mail) => sendMail(mail).catch((err) => console.error("Email-change mail failed:", err.message));
const BAD_LINK = "This link is invalid or has expired";

emailChangeRouter.post("/email/change", requireAuth, async (req, res) => {
  try {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      const emailProblem = parsed.error.issues.some((i) => i.path[0] === "newEmail");
      return res.status(400).json({ error: emailProblem ? "Enter a valid email address" : "Enter your password and the new email address" });
    }
    const { newEmail, password, code } = parsed.data;
    if (!mailAvailable()) return res.status(503).json({ error: "Email isn't set up on this site yet, so the address can't be changed." });
    if (await passwordFails.isLimited(req.user.id)) return tooMany(res, passwordFails.windowSeconds);

    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (!(await user.comparePassword(password))) {
      await passwordFails.hit(req.user.id);
      return res.status(403).json({ error: "That password isn't right" });
    }
    // With two-step sign-in on, the second step is asked for here too: a stolen session and password alone shouldn't be able to move the address.
    if (user.twoFactor?.enabled) {
      if (await codeFails.isLimited(req.user.id)) return tooMany(res, codeFails.windowSeconds);
      if (!code || !(await checkSecondStep(user, code))) {
        await codeFails.hit(req.user.id);
        return res.status(401).json({ error: "Enter a code from your authenticator app (or a recovery code) to change your email", code: "second_step_needed" });
      }
    }
    if (newEmail === user.email) return res.status(400).json({ error: "That is already your email address" });
    if (await User.exists({ email: newEmail })) return res.status(409).json({ error: "That email address is already used by another account" });
    if (!(await requestsPerHour.allow(req.user.id))) return tooMany(res, requestsPerHour.windowSeconds);

    await EmailChange.deleteMany({ user: user._id, kind: "pending" }); // only the newest link works
    const token = randomBytes(32).toString("hex");
    await EmailChange.create({ user: user._id, kind: "pending", oldEmail: user.email, newEmail, tokenHash: hashToken(token), expireAt: new Date(Date.now() + PENDING_MS) });
    // the link goes in the fragment, which browsers never send to a server or in a Referer
    send({
      to: newEmail,
      ...emailFor("emailChangeConfirm", user, { name: user.displayName, username: user.username, link: `${baseUrl()}/confirm-email-change#token=${token}` }),
    });
    send({
      to: user.email,
      ...emailFor("emailChangeAsked", user, { name: user.displayName, masked: maskEmail(newEmail) }),
    });
    res.status(204).end();
  } catch (err) {
    serverError(res, err);
  }
});

emailChangeRouter.post("/email/confirm", async (req, res) => {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: BAD_LINK });
    if (await linkFails.isLimited(clientIp(req))) return tooMany(res, linkFails.windowSeconds);

    const row = await EmailChange.findOne({ tokenHash: hashToken(parsed.data.token), kind: "pending", expireAt: { $gt: new Date() } });
    const user = row ? await User.findById(row.user) : null;
    if (!row || !user || user.suspendedAt) {
      await linkFails.hit(clientIp(req));
      return res.status(400).json({ error: BAD_LINK });
    }
    // The address on the account must still be the one the request was made from (nothing else changed it meanwhile).
    if (user.email !== row.oldEmail) {
      await EmailChange.deleteOne({ _id: row._id });
      return res.status(400).json({ error: BAD_LINK });
    }
    try {
      const changed = await User.updateOne({ _id: user._id, email: row.oldEmail }, { email: row.newEmail, emailVerified: true });
      if (changed.modifiedCount !== 1) return res.status(400).json({ error: BAD_LINK });
    } catch (err) {
      if (err?.code === 11000) {
        await EmailChange.deleteOne({ _id: row._id });
        return res.status(409).json({ error: "That email address is already used by another account" });
      }
      throw err;
    }
    await EmailVerification.deleteMany({ user: user._id }); // a "confirm" link for the old address is no use now

    // From now on the same row is the way back: its new link goes to the OLD address.
    const revertToken = randomBytes(32).toString("hex");
    await EmailChange.updateOne({ _id: row._id }, { kind: "revertible", tokenHash: hashToken(revertToken), expireAt: new Date(Date.now() + REVERT_MS) });
    send({
      to: row.oldEmail,
      ...emailFor("emailChanged", user, { name: user.displayName, masked: maskEmail(row.newEmail), link: `${baseUrl()}/undo-email-change#token=${revertToken}` }),
    });
    res.status(204).end();
  } catch (err) {
    serverError(res, err);
  }
});

emailChangeRouter.post("/email/revert", async (req, res) => {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: BAD_LINK });
    if (await linkFails.isLimited(clientIp(req))) return tooMany(res, linkFails.windowSeconds);

    const row = await EmailChange.findOne({ tokenHash: hashToken(parsed.data.token), kind: "revertible", expireAt: { $gt: new Date() } });
    const user = row ? await User.findById(row.user) : null;
    if (!row || !user) {
      await linkFails.hit(clientIp(req));
      return res.status(400).json({ error: BAD_LINK });
    }
    try {
      // Putting the old address back also invalidates every sign-in made before this moment, whoever holds it.
      const changed = await User.updateOne({ _id: user._id, email: row.newEmail }, { email: row.oldEmail, emailVerified: true, passwordChangedAt: new Date() });
      if (changed.modifiedCount !== 1) {
        await EmailChange.deleteOne({ _id: row._id });
        return res.status(400).json({ error: BAD_LINK });
      }
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: "That address is now used by another account, so it can't be put back. Contact the site's team." });
      throw err;
    }
    await Promise.all([endAllSessions(user._id), Passkey.deleteMany({ user: user._id }), PasswordReset.deleteMany({ user: user._id }), EmailChange.deleteMany({ user: user._id }), EmailVerification.deleteMany({ user: user._id })]);
    send({
      to: row.oldEmail,
      ...emailFor("emailRestored", user, { name: user.displayName, masked: maskEmail(row.oldEmail) }),
    });
    res.status(204).end();
  } catch (err) {
    serverError(res, err);
  }
});
