import { Router } from "express";
import { z } from "zod";
import { User } from "../models/User.js";
import { requireAuth, clearAuthCookie } from "../middleware/auth.js";
import { endAllSessions, endSessionOf, startSession } from "../services/sessions.js";
import { signChallenge } from "../services/twoFactor.js";
import { Passkey } from "../models/Passkey.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { usernameSchema } from "../utils/username.js";
import { UsernameHistory } from "../models/UsernameHistory.js";
import { PasswordReset } from "../models/PasswordReset.js";
import { sendMail, mailAvailable } from "../utils/mailer.js";
import { primaryClientUrl } from "../utils/origins.js";
import { sendVerificationEmail } from "../services/emailVerification.js";
import { redeemInvite } from "../services/invites.js";
import { createHash, randomBytes } from "node:crypto";

export const authRouter = Router();

// Brute-force / abuse protection. Login counts only FAILED attempts, per email
// (stops guessing one account from many IPs) and per IP (stops one client
// trying many accounts), so normal use never burns the budget. Registration
// is capped per IP.
const FIFTEEN_MIN = 15 * 60 * 1000;
const loginFailsByEmail = createLimiter({ name: "login-email", limit: 10, windowMs: FIFTEEN_MIN });
const loginFailsByIp = createLimiter({ name: "login-ip", limit: 30, windowMs: FIFTEEN_MIN });
const registrationsByIp = createLimiter({ name: "register-ip", limit: 10, windowMs: 60 * 60 * 1000 });

function tooManyAttempts(res, seconds) {
  res.set("Retry-After", String(seconds));
  return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
}

const registerSchema = z.object({
  email: z.string().email(),
  username: usernameSchema,
  password: z.string().min(8).max(72),
  displayName: z.string().min(1).max(80),
  // The code from an invite link, if they came in through one.
  invite: z.string().max(64).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/register", async (req, res) => {
  try {
    if (!(await registrationsByIp.allow(clientIp(req)))) return tooManyAttempts(res, registrationsByIp.windowSeconds);

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { email, username, password, displayName, invite } = parsed.data;

    const existing = await User.findOne({ $or: [{ email }, { username: username.toLowerCase() }] });
    if (existing || (await UsernameHistory.exists({ username: username.toLowerCase() }))) {
      return res.status(409).json({ error: "Email or username already taken" });
    }

    const user = new User({ email, username, displayName });
    user.password = password;
    await user.save();

    // Ask them to confirm the address. Sent after we've replied, and a failure never affects sign-up.
    sendVerificationEmail(user).catch((err) => console.error("Verification email failed:", err.message));

    // Came in through an invite link: count it and make them friends. A problem here never stops the sign-up.
    let invitedBy = null;
    if (invite) {
      try {
        invitedBy = (await redeemInvite(invite, user))?.username ?? null;
      } catch (err) {
        console.error("Invite redemption failed:", err.message);
      }
    }

    await startSession(req, res, user);
    res.status(201).json({ user: await toPublicUser(user, user._id), ...(invitedBy ? { invitedBy } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { email, password } = parsed.data;
    const emailKey = email.toLowerCase();

    if ((await loginFailsByEmail.isLimited(emailKey)) || (await loginFailsByIp.isLimited(clientIp(req)))) {
      return tooManyAttempts(res, loginFailsByEmail.windowSeconds);
    }

    const user = await User.findOne({ email });
    const matches = user ? await user.comparePassword(password) : false;
    if (!matches) {
      await Promise.all([loginFailsByEmail.hit(emailKey), loginFailsByIp.hit(clientIp(req))]);
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Said only after the password was right, so it can't be used to find out which accounts are suspended.
    if (user.suspendedAt) return res.status(403).json({ error: "This account has been suspended. If you think that is a mistake, contact the site's team.", code: "account_suspended" });

    // Right password, but they've asked for a second step: no cookie yet. What comes back is a short-lived note that the password was
    // right, which only /login/2fa accepts, and only together with a code (see routes/twoFactor.routes.js).
    if (user.twoFactor?.enabled) return res.status(200).json({ twoFactorRequired: true, challenge: signChallenge(user) });

    await startSession(req, res, user, { notify: true });
    res.status(200).json({ user: await toPublicUser(user, user._id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(72),
});
const passwordChangeFails = createLimiter({ name: "change-password", limit: 5, windowMs: FIFTEEN_MIN });

// Change your own password. Needs the current one (a stolen session alone
// can't lock the real owner out) and is throttled like login.
authRouter.put("/password", requireAuth, async (req, res) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { currentPassword, newPassword } = parsed.data;
    if (await passwordChangeFails.isLimited(req.user.id)) return tooManyAttempts(res, passwordChangeFails.windowSeconds);

    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (!(await user.comparePassword(currentPassword))) {
      await passwordChangeFails.hit(req.user.id);
      return res.status(403).json({ error: "Current password is incorrect" });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "Choose a password different from your current one" });
    }

    user.password = newPassword;
    // Every other session (any token issued before now) stops working; this
    // one is re-issued so the person changing their password stays signed in.
    user.passwordChangedAt = new Date();
    await user.save();
    await endAllSessions(user._id);
    await startSession(req, res, user);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- Forgotten password ---------------------------------------------------
// forgot-password always answers the same way whether or not the address has an
// account (so it can't be used to find out who is registered), and does its work
// after replying so the response time doesn't give it away either. The link holds a
// random token that is single-use, expires in an hour and is stored only as a hash.
// It goes in the URL fragment, which browsers never send to a server or in a Referer.
const RESET_TTL_MS = 60 * 60 * 1000;
const resetByEmail = createLimiter({ name: "forgot-email", limit: 3, windowMs: 60 * 60 * 1000 });
const resetByIp = createLimiter({ name: "forgot-ip", limit: 10, windowMs: 60 * 60 * 1000 });
const resetFails = createLimiter({ name: "reset-fail", limit: 10, windowMs: FIFTEEN_MIN });
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(8).max(72) });

async function emailResetLink(email) {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return;
  await PasswordReset.deleteMany({ user: user._id }); // only the newest link works
  const token = randomBytes(32).toString("hex");
  await PasswordReset.create({ user: user._id, tokenHash: hashToken(token), expireAt: new Date(Date.now() + RESET_TTL_MS) });
  const base = process.env.CLIENT_URL ? primaryClientUrl() : "http://localhost:5173";
  await sendMail({
    to: user.email,
    subject: "Reset your CreativesSelect password",
    text:
      `Hi ${user.displayName},\n\n` +
      "Someone asked to reset the password for your CreativesSelect account. " +
      "To choose a new one, open this link within an hour:\n\n" +
      `${base}/reset-password#token=${token}\n\n` +
      "If that wasn't you, ignore this email — your password stays as it is.",
  });
}

// Lets the page say so up front when this site can't send email yet, instead of promising a link
// that will never arrive. (A site-wide fact, so it reveals nothing about any account.)
authRouter.get("/reset-available", (req, res) => res.json({ available: mailAvailable() }));

authRouter.post("/forgot-password", async (req, res) => {
  try {
    if (!mailAvailable()) return res.status(503).json({ error: "Password reset by email isn't set up on this site yet." });
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a valid email address" });
    const emailKey = parsed.data.email.toLowerCase();
    // Counted for every address, real or not, so the limit itself reveals nothing.
    if (!(await resetByEmail.allow(emailKey)) || !(await resetByIp.allow(clientIp(req)))) {
      return tooManyAttempts(res, resetByEmail.windowSeconds);
    }
    res.status(200).json({ message: "If that email has an account, a reset link is on its way." });
    emailResetLink(emailKey).catch((err) => console.error("Password reset email failed:", err.message));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.post("/reset-password", async (req, res) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      const tokenProblem = parsed.error.issues.some((i) => i.path[0] === "token");
      return res.status(400).json({ error: tokenProblem ? "This reset link is invalid or has expired" : parsed.error.issues[0].message });
    }
    if (await resetFails.isLimited(clientIp(req))) return tooManyAttempts(res, resetFails.windowSeconds);

    const reset = await PasswordReset.findOne({ tokenHash: hashToken(parsed.data.token), expireAt: { $gt: new Date() } });
    const user = reset ? await User.findById(reset.user) : null;
    if (!reset || !user) {
      await resetFails.hit(clientIp(req));
      return res.status(400).json({ error: "This reset link is invalid or has expired" });
    }

    user.password = parsed.data.newPassword;
    // They opened a link we emailed to this address, which also proves they own it.
    user.emailVerified = true;
    // Every existing session stops working, so whoever had access with the old
    // password (or a stolen session) is signed out. The person resetting signs in afresh.
    user.passwordChangedAt = new Date();
    await user.save();
    await endAllSessions(user._id);
    // Anyone who had got in could have added a passkey, which would outlive this reset: so the way back removes them all.
    const removedPasskeys = (await Passkey.deleteMany({ user: user._id })).deletedCount;
    await PasswordReset.deleteMany({ user: user._id });
    sendMail({
      to: user.email,
      subject: "Your CreativesSelect password was changed",
      text:
        `Hi ${user.displayName},\n\n` +
        "The password for your CreativesSelect account was just reset. If that was you, there's nothing to do. " +
        (removedPasskeys ? "Any passkeys on the account were removed too, as a precaution: add them again from your profile settings. " : "") +
        "If it wasn't, reset it again right away.",
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.post("/logout", async (req, res) => {
  await endSessionOf(req);
  clearAuthCookie(res);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    res.json({ user: await toPublicUser(user, req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});
