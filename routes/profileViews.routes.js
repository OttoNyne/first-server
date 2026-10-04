import { Router } from "express";
import { ProfileView } from "../models/ProfileView.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { blockedUserIds, getProfileForViewer } from "../utils/visibility.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";

// Opt-in profile views. A visit is recorded, and shown, only when BOTH people have turned it on: you can see who visited
// your profile only if you let people see your visits to theirs. Nothing is recorded for anyone who hasn't opted in.
export const profileViewsRouter = Router();
profileViewsRouter.use(requireAuth);

export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const AGAIN_AFTER_MS = 30 * 60 * 1000; // a second look within half an hour is the same visit
const LIST_SIZE = 50;
const visitLimiter = createLimiter({ name: "profile-view", limit: 300, windowMs: 60 * 60 * 1000 });

// The page calls this when someone opens another person's profile. It always answers the same way (204), so it can't be used to
// find out whether the profile's owner has the feature on, whether the profile exists, or whether you may see it.
profileViewsRouter.post("/:username", async (req, res) => {
  try {
    const viewer = await User.findById(req.user.id).select("profileViews");
    if (!viewer?.profileViews) return res.status(204).end();
    if (!(await visitLimiter.allow(req.user.id))) return res.status(204).end();
    const owner = await getProfileForViewer(String(req.params.username).toLowerCase(), req.user.id); // throws if you can't see it
    if (String(owner._id) === String(req.user.id) || !owner.profileViews) return res.status(204).end();
    const now = new Date();
    const existing = await ProfileView.findOne({ owner: owner._id, viewer: req.user.id });
    if (existing && now - existing.lastViewedAt < AGAIN_AFTER_MS) return res.status(204).end();
    await ProfileView.updateOne({ owner: owner._id, viewer: req.user.id }, { $set: { lastViewedAt: now, expireAt: new Date(now.getTime() + KEEP_MS) } }, { upsert: true });
  } catch {
    // not visible, missing, or a hiccup: the answer is the same
  }
  res.status(204).end();
});

// Who has visited your profile in the last 30 days, newest first. Only for someone who has turned it on, and only the visitors
// who have it on themselves and whom you haven't blocked. Dates are days, not times.
profileViewsRouter.get("/", async (req, res) => {
  const me = await User.findById(req.user.id).select("profileViews");
  if (!me?.profileViews) return res.status(403).json({ error: "Turn on profile views to see who visits your profile", code: "profile_views_off" });
  const blocked = await blockedUserIds(req.user.id);
  const rows = await ProfileView.find({ owner: req.user.id, expireAt: { $gt: new Date() } })
    .sort({ lastViewedAt: -1 })
    .limit(LIST_SIZE * 2)
    .populate("viewer");
  const visitors = [];
  for (const row of rows) {
    if (visitors.length >= LIST_SIZE) break;
    if (!row.viewer || !row.viewer.profileViews || blocked.has(String(row.viewer._id))) continue;
    visitors.push({ user: await toPublicUser(row.viewer, req.user.id), day: row.lastViewedAt.toISOString().slice(0, 10) });
  }
  res.json({ visitors });
});
