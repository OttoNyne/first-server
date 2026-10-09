import { Router } from "express";
import mongoose from "mongoose";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { MediaItem } from "../models/MediaItem.js";
import { attachUserIfPresent } from "../middleware/auth.js";
import { blockedUserIds } from "../utils/visibility.js";
import { clientIp } from "../utils/clientIp.js";
import { createLimiter } from "../utils/rateLimit.js";
import { normalizeTag } from "../utils/hashtags.js";
import { summarise } from "../utils/reactions.js";
import { toPublicMediaItem, toPublicPost } from "../utils/serialize.js";
import { savedIdsOf } from "../utils/saves.js";
import { POST_POPULATE } from "./saves.routes.js";

// Explore: the public posts and portfolio pieces of people with public profiles, newest first, optionally about one #hashtag, and the
// topics people have been using this week. Anyone can look (nothing here is shown that a visitor couldn't open on the person's profile),
// so it only ever includes public, unsuspended people, leaves out anyone the viewer has blocked or been blocked by, and asks search
// engines to keep out of the page that shows it (a person's profile is only listed there if they opted in).
export const exploreRouter = Router();
exploreRouter.use(attachUserIfPresent);

export const PAGE = 20;
const SCAN = 60; // candidates looked at in one go
const ROUNDS = 3; // and how many times, to fill a page when many candidates are private or blocked
const TRENDING_DAYS = 7;
const TRENDING_LOOKED_AT = 3000;
export const TRENDING_SHOWN = 12;
const limiter = createLimiter({ name: "explore", limit: 300, windowMs: 60 * 60 * 1000 });

const person = (user) => ({ id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null, csVerified: Boolean(user.csVerifiedByAdmin || user.csVerifiedEarned) });
const cursorOf = (value) => (typeof value === "string" && mongoose.isValidObjectId(value) ? value : null);

exploreRouter.use(async (req, res, next) => {
  if (await limiter.allow(req.user?.id ?? clientIp(req))) return next();
  res.set("Retry-After", String(limiter.windowSeconds));
  res.status(429).json({ error: "You're looking around too fast — try again in a bit" });
});

/** Newest-first documents (with their authors) that this viewer may be shown, `PAGE` of them, found by looking at a few batches. */
async function scan({ model, ownerField, populate = ownerField, filter, before, blocked }) {
  const kept = [];
  let cursor = before;
  let exhausted = false;
  for (let round = 0; round < ROUNDS && kept.length <= PAGE; round++) {
    const found = await model
      .find({ ...filter, ...(cursor ? { _id: { $lt: cursor } } : {}) })
      .sort({ _id: -1 })
      .limit(SCAN)
      .populate(populate);
    for (const doc of found) {
      cursor = doc._id;
      const owner = doc[ownerField];
      if (owner && !owner.isPrivate && !owner.suspendedAt && !blocked.has(String(owner._id))) kept.push(doc);
      if (kept.length > PAGE) break;
    }
    if (found.length < SCAN) {
      exhausted = true;
      break;
    }
  }
  const docs = kept.slice(0, PAGE);
  return { docs, hasMore: kept.length > PAGE || !exhausted, next: docs.length ? String(docs[docs.length - 1]._id) : null };
}

// The latest public posts or pieces, or those about one tag: GET /api/explore?type=posts|pieces&tag=ceramics&before=<id>
exploreRouter.get("/", async (req, res) => {
  const type = req.query.type === "pieces" ? "pieces" : "posts";
  const asked = typeof req.query.tag === "string" && req.query.tag.trim() ? req.query.tag : null;
  const tag = asked ? normalizeTag(asked) : null;
  if (asked && !tag) return res.status(400).json({ error: "That isn't a topic you can search for" });
  const before = cursorOf(req.query.before);
  const blocked = req.user ? await blockedUserIds(req.user.id) : new Set();
  const filter = tag ? { tags: tag } : {};

  if (type === "posts") {
    const { docs, hasMore, next } = await scan({ model: Post, ownerField: "author", populate: POST_POPULATE, filter, before, blocked });
    const ids = docs.map((p) => p._id);
    const saved = await savedIdsOf("post", ids, req.user?.id);
    const [counts, reactions] = await Promise.all([Comment.aggregate([{ $match: { post: { $in: ids } } }, { $group: { _id: "$post", count: { $sum: 1 } } }]), summarise("post", ids, req.user?.id)]);
    const countOf = new Map(counts.map((c) => [String(c._id), c.count]));
    const posts = await Promise.all(docs.map((p) => toPublicPost(p, countOf.get(String(p._id)) || 0, req.user?.id, reactions.get(String(p._id)), { saved: saved.has(String(p._id)) })));
    return res.json({ type, tag, posts, hasMore, next });
  }

  const { docs, hasMore, next } = await scan({ model: MediaItem, ownerField: "owner", filter, before, blocked });
  const reactions = await summarise("media", docs.map((i) => i._id), req.user?.id);
  const savedPieces = await savedIdsOf("piece", docs.map((i) => i._id), req.user?.id);
  const pieces = docs.map((item) => ({ id: item._id, item: { ...toPublicMediaItem(item, { reactions: reactions.get(String(item._id)) }), saved: savedPieces.has(String(item._id)) }, owner: person(item.owner), createdAt: item.createdAt }));
  res.json({ type, tag, pieces, hasMore, next });
});

// The topics used this week, most people first: GET /api/explore/trending. Only public, unsuspended people are counted, and a tag
// counts once per person however often they use it, so one person repeating a tag can't make it trend.
exploreRouter.get("/trending", async (req, res) => {
  const since = new Date(Date.now() - TRENDING_DAYS * 24 * 60 * 60 * 1000);
  const count = (model, ownerField) =>
    model.aggregate([
      { $match: { createdAt: { $gte: since }, "tags.0": { $exists: true } } },
      { $sort: { _id: -1 } },
      { $limit: TRENDING_LOOKED_AT },
      { $lookup: { from: "users", localField: ownerField, foreignField: "_id", as: "who" } },
      { $match: { "who.isPrivate": { $ne: true }, "who.suspendedAt": null, "who.0": { $exists: true } } },
      { $unwind: "$tags" },
      { $group: { _id: "$tags", people: { $addToSet: `$${ownerField}` }, uses: { $sum: 1 } } },
    ]);
  const [fromPosts, fromPieces] = await Promise.all([count(Post, "author"), count(MediaItem, "owner")]);
  const merged = new Map();
  for (const row of [...fromPosts, ...fromPieces]) {
    const now = merged.get(row._id) ?? { people: new Set(), uses: 0 };
    row.people.forEach((p) => now.people.add(String(p)));
    now.uses += row.uses;
    merged.set(row._id, now);
  }
  const tags = [...merged.entries()]
    .map(([tag, v]) => ({ tag, people: v.people.size, uses: v.uses }))
    .sort((a, b) => b.people - a.people || b.uses - a.uses || a.tag.localeCompare(b.tag))
    .slice(0, TRENDING_SHOWN);
  res.set("Cache-Control", "public, max-age=300");
  res.json({ tags, days: TRENDING_DAYS });
});
