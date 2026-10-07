import { Router } from "express";
import { EmailVerification } from "../models/EmailVerification.js";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Session } from "../models/Session.js";
import { startSession } from "../services/sessions.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { mailAvailable } from "../utils/mailer.js";
import { hashToken, sendVerificationEmail } from "../services/emailVerification.js";

// Account-security routes: confirming the email address, and the person's own list of where they're signed in.
// Mounted under /api/auth alongside the sign-in routes.
export const securityRouter = Router();

const FIFTEEN_MIN = 15 * 60 * 1000;
const verifyFails = createLimiter({ name: "verify-email-fail", limit: 20, windowMs: FIFTEEN_MIN });
const endSessionsLimiter = createLimiter({ name: "end-sessions", limit: 30, windowMs: 60 * 60 * 1000 });
const resendLimiter = createLimiter({ name: "verify-email-resend", limit: 3, windowMs: 60 * 60 * 1000 });

// The link in the email lands on a page that posts the token here. The token alone proves it: the person
// doesn't have to be signed in on the device where they open the email.
securityRouter.post("/verify-email", async (req, res) => {
  try {
    const token = req.body?.token;
    if (typeof token !== "string" || token.length < 20 || token.length > 200) {
      return res.status(400).json({ error: "This verification link is invalid or has expired" });
    }
    if (await verifyFails.isLimited(clientIp(req))) {
      res.set("Retry-After", String(verifyFails.windowSeconds));
      return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
    }
    const row = await EmailVerification.findOne({ tokenHash: hashToken(token), expireAt: { $gt: new Date() } });
    const user = row ? await User.findById(row.user) : null;
    if (!row || !user) {
      await verifyFails.hit(clientIp(req));
      return res.status(400).json({ error: "This verification link is invalid or has expired" });
    }
    user.emailVerified = true;
    await user.save();
    await EmailVerification.deleteMany({ user: user._id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

securityRouter.post("/resend-verification", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (user.emailVerified) return res.status(400).json({ error: "Your email is already confirmed" });
    if (!mailAvailable()) return res.status(503).json({ error: "Email isn't set up on this site yet." });
    if (!(await resendLimiter.allow(req.user.id))) {
      res.set("Retry-After", String(resendLimiter.windowSeconds));
      return res.status(429).json({ error: "You've asked for several emails — check your inbox (and spam), or try again in an hour." });
    }
    const sent = await sendVerificationEmail(user);
    if (!sent) return res.status(502).json({ error: "Couldn't send the email right now — please try again later." });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- Where you're signed in -------------------------------------------------
// Every sign-in has a row (models/Session.js) that its cookie points to. The owner can see them, end one, or end all the others;
// an ended one stops working on its very next request. Everything here is about the signed-in person's own devices only.
const show = (session, currentId) => ({
  id: String(session._id),
  device: session.device,
  current: String(session._id) === String(currentId),
  createdAt: session.createdAt,
  lastSeenAt: session.lastSeenAt,
});

// A sign-in from before this list existed has no row. It gets one now (and a fresh cookie), so "this device" is always in the list.
async function ensureTracked(req, res) {
  if (req.user.sid) return req.user.sid;
  const user = await User.findById(req.user.id);
  if (!user) return null;
  const session = await startSession(req, res, user);
  req.user.sid = String(session._id);
  return req.user.sid;
}

function tooMany(res) {
  res.set("Retry-After", String(endSessionsLimiter.windowSeconds));
  return res.status(429).json({ error: "You've ended a lot of sign-ins — please wait a little and try again." });
}

securityRouter.get("/sessions", requireAuth, async (req, res) => {
  try {
    const currentId = await ensureTracked(req, res);
    if (!currentId) return res.status(401).json({ error: "Not authenticated" });
    const sessions = await Session.find({ user: req.user.id }).sort({ lastSeenAt: -1 });
    const person = await User.findById(req.user.id).select("signInAlerts");
    res.json({ sessions: sessions.map((s) => show(s, currentId)).sort((a, b) => Number(b.current) - Number(a.current)), signInAlerts: person?.signInAlerts !== false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Sign out everywhere else: every other device is ended and this one stays.
securityRouter.post("/sessions/end-others", requireAuth, async (req, res) => {
  try {
    if (!(await endSessionsLimiter.allow(req.user.id))) return tooMany(res);
    const currentId = await ensureTracked(req, res);
    if (!currentId) return res.status(401).json({ error: "Not authenticated" });
    const { deletedCount } = await Session.deleteMany({ user: req.user.id, _id: { $ne: currentId } });
    await User.updateOne({ _id: req.user.id }, { sessionsRevokedAt: new Date() });
    res.json({ ended: deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Whether to be emailed when someone signs in from a browser the person hasn't used before (on by default).
securityRouter.put("/sign-in-alerts", requireAuth, async (req, res) => {
  try {
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "Say whether to turn these emails on or off" });
    await User.updateOne({ _id: req.user.id }, { signInAlerts: req.body.enabled });
    res.json({ signInAlerts: req.body.enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

securityRouter.delete("/sessions/:id", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "That sign-in wasn't found" });
    if (!(await endSessionsLimiter.allow(req.user.id))) return tooMany(res);
    const currentId = await ensureTracked(req, res);
    if (!currentId) return res.status(401).json({ error: "Not authenticated" });
    if (String(req.params.id) === String(currentId)) return res.status(400).json({ error: "That's the device you're using — use Log out for it." });
    // Only the owner's own: someone else's id is answered exactly like one that doesn't exist.
    const { deletedCount } = await Session.deleteOne({ _id: req.params.id, user: req.user.id });
    if (!deletedCount) return res.status(404).json({ error: "That sign-in wasn't found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});
