import { Router } from "express";
import { Follow } from "../models/Follow.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { areBlocked, blockedUserIds } from "../utils/visibility.js";
import { createLimiter } from "../utils/rateLimit.js";

// Following: seeing someone's public posts in your feed without being friends. One-way, no yes needed from them, public profiles only.
export const followsRouter = Router();
followsRouter.use(requireAuth);

export const MAX_FOLLOWING = 1000;
export const PAGE = 30;
const followLimiter = createLimiter({ name: "follow", limit: 60, windowMs: 60 * 60 * 1000 });
const NOTICE_EVERY_MS = 7 * 24 * 60 * 60 * 1000; // following, unfollowing and following again must not ping the person every time

const person = (user) => ({ id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null, csVerified: Boolean(user.csVerifiedByAdmin || user.csVerifiedEarned) });
const notFound = (res) => res.status(404).json({ error: "That profile can't be followed" });

/** The ids of the people a person follows whose profiles are still public, not suspended, and not blocked either way. */
export async function followedAuthorIds(userId) {
  const rows = await Follow.find({ follower: userId }).sort({ createdAt: -1 }).limit(MAX_FOLLOWING).select("following");
  if (!rows.length) return [];
  const [users, blocked] = await Promise.all([User.find({ _id: { $in: rows.map((r) => r.following) }, isPrivate: { $ne: true }, suspendedAt: null }).select("_id"), blockedUserIds(userId)]);
  return users.map((u) => u._id).filter((id) => !blocked.has(String(id)));
}

// Follow someone. The same answer for a profile that doesn't exist, is private, is suspended or has a block either way. Following twice changes nothing.
followsRouter.post("/:username", async (req, res) => {
  const target = await User.findOne({ username: String(req.params.username).toLowerCase() });
  if (!target || target.isPrivate || target.suspendedAt) return notFound(res);
  if (String(target._id) === req.user.id) return res.status(400).json({ error: "You can't follow yourself" });
  if (await areBlocked(req.user.id, target._id)) return notFound(res);

  if (await Follow.exists({ follower: req.user.id, following: target._id })) return res.json({ following: true });
  if ((await Follow.countDocuments({ follower: req.user.id })) >= MAX_FOLLOWING) return res.status(400).json({ error: `You can follow up to ${MAX_FOLLOWING} people — unfollow someone first` });
  if (!(await followLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're following people too fast — try again later." });

  try {
    await Follow.create({ follower: req.user.id, following: target._id });
  } catch (err) {
    if (err?.code !== 11000) throw err; // two taps at once: already following
    return res.json({ following: true });
  }
  const recent = await Notification.exists({ recipient: target._id, type: "follow", "payload.actorId": String(req.user.id), createdAt: { $gt: new Date(Date.now() - NOTICE_EVERY_MS) } });
  if (!recent) await Notification.create({ recipient: target._id, type: "follow", payload: { actorId: String(req.user.id) } }).catch(() => {});
  res.status(201).json({ following: true });
});

// Stop following. Always 204, whether or not you were.
followsRouter.delete("/:username", async (req, res) => {
  const target = await User.findOne({ username: String(req.params.username).toLowerCase() }).select("_id");
  if (target) await Follow.deleteOne({ follower: req.user.id, following: target._id });
  res.status(204).end();
});

async function listPeople(req, res, side) {
  const page = Math.min(1000, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const rows = await Follow.find({ [side === "following" ? "follower" : "following"]: req.user.id })
    .sort({ createdAt: -1 })
    .skip((page - 1) * PAGE)
    .limit(PAGE + 1);
  const ids = rows.slice(0, PAGE).map((r) => r[side]);
  const [users, blocked] = await Promise.all([User.find({ _id: { $in: ids }, suspendedAt: null }), blockedUserIds(req.user.id)]);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const people = ids.map((id) => byId.get(String(id))).filter((u) => u && !blocked.has(String(u._id))).map(person);
  res.json({ people, page, hasMore: rows.length > PAGE });
}

// Your own lists: who you follow, and who follows you (nobody else's).
followsRouter.get("/following", (req, res) => listPeople(req, res, "following"));
followsRouter.get("/followers", (req, res) => listPeople(req, res, "follower"));
