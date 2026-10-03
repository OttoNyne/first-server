import { Router } from "express";
import { EmailVerification } from "../models/EmailVerification.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { mailAvailable } from "../utils/mailer.js";
import { hashToken, sendVerificationEmail } from "../services/emailVerification.js";

// Account-security routes: confirming the email address (and, further down, two-step sign-in).
// Mounted under /api/auth alongside the sign-in routes.
export const securityRouter = Router();

const FIFTEEN_MIN = 15 * 60 * 1000;
const verifyFails = createLimiter({ name: "verify-email-fail", limit: 20, windowMs: FIFTEEN_MIN });
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
