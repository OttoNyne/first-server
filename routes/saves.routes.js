import { Router } from "express";
import mongoose from "mongoose";
import { Save } from "../models/Save.js";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { MediaItem } from "../models/MediaItem.js";
import { requireAuth } from "../middleware/auth.js";
import { assertVisible, blockedUserIds } from "../utils/visibility.js";
import { createLimiter } from "../utils/rateLimit.js";
import { summarise } from "../utils/reactions.js";
import { toPublicMediaItem, toPublicPost } from "../utils/serialize.js";
import { pollTallies } from "../utils/polls.js";

// Saving: a private list of posts and portfolio pieces to come back to. Only the person who saved sees it, and an item shows in it only while
// the person who made it could still be seen by them (a profile that went private, or a block, takes it out of the list, not out of storage).
export const savesRouter = Router();
savesRouter.use(requireAuth);

export const MAX_SAVED = 2000;
export const PAGE = 20;
const saveLimiter = createLimiter({ name: "save", limit: 120, windowMs: 60 * 60 * 1000 });
export const POST_POPULATE = [{ path: "author" }, { path: "repostOf", populate: { path: "author" } }];

const KINDS = { posts: { type: "post", model: Post, owner: "author" }, pieces: { type: "piece", model: MediaItem, owner: "owner" } };
const KIND_OF = { posts: "posts", pieces: "pieces" };
const missing = (res, kind) => res.status(404).json({ error: kind === "posts" ? "Post not found" : "Media item not found" });

async function loadVisible(kind, id, viewerId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const { model, owner } = KINDS[kind];
  const doc = await model.findById(id).populate(owner);
  if (!doc || !doc[owner]) return null;
  try {
    await assertVisible(doc[owner], viewerId);
  } catch {
    return null; // the same answer as a missing one, so a private profile's posts aren't revealed
  }
  return doc;
}

function routesFor(kind) {
  const { type } = KINDS[kind];
  // Save one. Saving twice changes nothing.
  savesRouter.put(`/${kind}/:id`, async (req, res) => {
    const doc = await loadVisible(kind, req.params.id, req.user.id);
    if (!doc) return missing(res, kind);
    if (await Save.exists({ user: req.user.id, targetType: type, target: doc._id })) return res.json({ saved: true });
    if ((await Save.countDocuments({ user: req.user.id })) >= MAX_SAVED) return res.status(400).json({ error: `You can save up to ${MAX_SAVED} things — remove some first` });
    if (!(await saveLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're saving things too fast — try again in a bit" });
    try {
      await Save.create({ user: req.user.id, targetType: type, target: doc._id });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    res.status(201).json({ saved: true });
  });
  // Take it out of the list. Always 204.
  savesRouter.delete(`/${kind}/:id`, async (req, res) => {
    if (mongoose.isValidObjectId(req.params.id)) await Save.deleteOne({ user: req.user.id, targetType: type, target: req.params.id });
    res.status(204).end();
  });
}
routesFor("posts");
routesFor("pieces");

// Your saved posts or pieces, most recently saved first: GET /api/saves?type=posts|pieces&before=<save id>
savesRouter.get("/", async (req, res) => {
  const kind = KIND_OF[req.query.type] ?? "posts";
  const { type, model, owner } = KINDS[kind];
  const before = typeof req.query.before === "string" && mongoose.isValidObjectId(req.query.before) ? req.query.before : null;
  const rows = await Save.find({ user: req.user.id, targetType: type, ...(before ? { _id: { $lt: before } } : {}) })
    .sort({ _id: -1 })
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const next = page.length ? String(page[page.length - 1]._id) : null;
  const docs = await model.find({ _id: { $in: page.map((r) => r.target) } }).populate(kind === "posts" ? POST_POPULATE : owner);
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const blocked = await blockedUserIds(req.user.id);
  const shown = [];
  for (const row of page) {
    const doc = byId.get(String(row.target));
    const who = doc?.[owner];
    if (!who || who.suspendedAt || blocked.has(String(who._id))) continue;
    try {
      await assertVisible(who, req.user.id);
    } catch {
      continue;
    }
    shown.push(doc);
  }
  const ids = shown.map((d) => d._id);
  if (kind === "posts") {
    const [counts, reactions] = await Promise.all([Comment.aggregate([{ $match: { post: { $in: ids } } }, { $group: { _id: "$post", count: { $sum: 1 } } }]), summarise("post", ids, req.user.id)]);
    const countOf = new Map(counts.map((c) => [String(c._id), c.count]));
    const polls = await pollTallies(shown, req.user.id);
    const posts = await Promise.all(shown.map((p) => toPublicPost(p, countOf.get(String(p._id)) || 0, req.user.id, reactions.get(String(p._id)), { saved: true, poll: polls.get(String(p._id)) })));
    return res.json({ type: kind, posts, hasMore: rows.length > PAGE, next });
  }
  const reactions = await summarise("media", ids, req.user.id);
  const pieces = shown.map((item) => ({
    id: item._id,
    item: { ...toPublicMediaItem(item, { reactions: reactions.get(String(item._id)) }), saved: true },
    owner: { id: item.owner._id, username: item.owner.username, displayName: item.owner.displayName, avatarUrl: item.owner.avatarUrl ?? null, csVerified: Boolean(item.owner.csVerifiedByAdmin || item.owner.csVerifiedEarned) },
    createdAt: item.createdAt,
  }));
  res.json({ type: kind, pieces, hasMore: rows.length > PAGE, next });
});
