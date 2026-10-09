import { Router } from "express";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { EVERY_MS, readUnsubscribeToken, runDigests } from "../services/digest.js";

// The weekly summary email: turn it on or off, a one-click way off from the email itself, and the call that sends the ones that are due.
export const digestRouter = Router();

const unsubscribeLimiter = createLimiter({ name: "digest-unsubscribe", limit: 30, windowMs: 15 * 60 * 1000 });
const toggleLimiter = createLimiter({ name: "digest-toggle", limit: 20, windowMs: 60 * 60 * 1000 });

const state = (user) => ({ enabled: user.weeklyDigest === true, emailVerified: user.emailVerified === true });

digestRouter.get("/", requireAuth, async (req, res) => {
  res.json(state(await User.findById(req.user.id).select("weeklyDigest emailVerified")));
});

// Turn it on or off: `{ enabled: true | false }`. Turning it on starts the week from now, so the first one comes in a week.
digestRouter.put("/", requireAuth, async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
  if (!(await toggleLimiter.allow(req.user.id))) return res.status(429).json({ error: "You've changed that a lot — try again later." });
  const now = new Date();
  const user = await User.findById(req.user.id).select("weeklyDigest emailVerified");
  if (req.body.enabled && !user.weeklyDigest) {
    user.weeklyDigest = true;
    user.digestSinceAt = now;
    user.digestNextAt = new Date(now.getTime() + EVERY_MS);
  } else if (!req.body.enabled) {
    user.weeklyDigest = false;
    user.digestNextAt = null;
  }
  await user.save();
  res.json(state(user));
});

// The link in the email: needs no sign-in, only the token the site signed for that person. The same answer for every bad token.
digestRouter.post("/unsubscribe", async (req, res) => {
  if (!(await unsubscribeLimiter.allow(clientIp(req)))) return res.status(429).json({ error: "Too many tries — try again in a few minutes." });
  const id = typeof req.body?.token === "string" ? readUnsubscribeToken(req.body.token) : null;
  if (!id) return res.status(400).json({ error: "That link isn't valid any more" });
  await User.updateOne({ _id: id }, { $set: { weeklyDigest: false, digestNextAt: null } });
  res.json({ enabled: false });
});

// Sends the summaries that are due, a few at a time. Anyone can ask (the scheduled check does), because asking can't make more go out than the
// schedule allows: each person is due once a week, a run does at most 25, and runs closer than five minutes apart do nothing.
let lastRun = 0;
digestRouter.post("/run", async (req, res) => {
  const now = Date.now();
  if (now - lastRun < 5 * 60 * 1000) return res.status(202).json({ skipped: true });
  lastRun = now;
  res.status(202).json(await runDigests({ now: new Date(now) }));
});

/** For tests: forget when the last run was. */
export const resetDigestRun = () => {
  lastRun = 0;
};
