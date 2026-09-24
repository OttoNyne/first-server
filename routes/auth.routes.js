import { Router } from "express";
import { z } from "zod";
import { User } from "../models/User.js";
import { requireAuth, signAuthToken, setAuthCookie, clearAuthCookie } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";

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
  username: z.string().min(3).max(30),
  password: z.string().min(8).max(72),
  displayName: z.string().min(1).max(80),
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
    const { email, username, password, displayName } = parsed.data;

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(409).json({ error: "Email or username already taken" });
    }

    const user = new User({ email, username, displayName });
    user.password = password;
    await user.save();

    const token = signAuthToken(user);
    setAuthCookie(res, token);
    res.status(201).json({ user: await toPublicUser(user, user._id) });
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

    const token = signAuthToken(user);
    setAuthCookie(res, token);
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
    setAuthCookie(res, signAuthToken(user));
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.post("/logout", (req, res) => {
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
