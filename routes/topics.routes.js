import { Router } from "express";
import { TagFollow } from "../models/TagFollow.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { normalizeTag } from "../utils/hashtags.js";

// Following topics: a #hashtag you want to keep up with. Private to you; the posts and pieces themselves are whatever Explore already shows.
export const topicsRouter = Router();
topicsRouter.use(requireAuth);

export const MAX_TOPICS = 30;
const topicLimiter = createLimiter({ name: "topic-follow", limit: 120, windowMs: 60 * 60 * 1000 });
const notATopic = (res) => res.status(400).json({ error: "That isn't a topic you can follow" });

/** The tags a person follows (most recently followed first). */
export async function followedTags(userId) {
  return (await TagFollow.find({ user: userId }).sort({ _id: -1 }).limit(MAX_TOPICS).select("tag").lean()).map((r) => r.tag);
}

// The topics you follow.
topicsRouter.get("/", async (req, res) => {
  res.json({ topics: await followedTags(req.user.id) });
});

// Follow one. Following twice changes nothing.
topicsRouter.put("/:tag", async (req, res) => {
  const tag = normalizeTag(req.params.tag);
  if (!tag) return notATopic(res);
  if (await TagFollow.exists({ user: req.user.id, tag })) return res.json({ following: true });
  if ((await TagFollow.countDocuments({ user: req.user.id })) >= MAX_TOPICS) return res.status(400).json({ error: `You can follow up to ${MAX_TOPICS} topics — unfollow one first` });
  if (!(await topicLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're following topics too fast — try again in a bit" });
  try {
    await TagFollow.create({ user: req.user.id, tag });
  } catch (err) {
    if (err?.code !== 11000) throw err; // two taps at once
  }
  res.status(201).json({ following: true });
});

// Stop following. Always 204.
topicsRouter.delete("/:tag", async (req, res) => {
  const tag = normalizeTag(req.params.tag);
  if (tag) await TagFollow.deleteOne({ user: req.user.id, tag });
  res.status(204).end();
});
