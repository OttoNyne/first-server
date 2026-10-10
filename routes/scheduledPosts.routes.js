import { Router } from "express";
import mongoose from "mongoose";
import { ScheduledPost } from "../models/ScheduledPost.js";
import { requireAuth } from "../middleware/auth.js";
import { MAX_POST, allowEdit, checkText } from "../utils/textInput.js";
import { readPoll } from "../utils/polls.js";
import { createLimiter } from "../utils/rateLimit.js";
import { toPublicPost } from "../utils/serialize.js";
import { readAlt, readFraming } from "./posts.routes.js";
import { MAX_AHEAD_MS, MAX_PENDING, MIN_AHEAD_MS, publishNow, removeScheduledPost } from "../services/scheduledPosts.js";

// Posts to be published later. Only the person who made one can ever see it (it is not a post until its time comes; see models/ScheduledPost.js).
// Everything a post can have is allowed (words, a picture and how it is framed, its description, a poll), and is checked the way a post is.
export const scheduledPostsRouter = Router();
scheduledPostsRouter.use(requireAuth);

const createLimit = createLimiter({ name: "scheduled-post", limit: 30, windowMs: 24 * 60 * 60 * 1000 });
const bad = (res, error, status = 400) => res.status(status).json({ error });
const notFound = (res) => bad(res, "Scheduled post not found", 404);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The time asked for: an ISO date-time at least a minute from now and at most 90 days away. Returns { value } or { error }. */
function readTime(raw, now = Date.now()) {
  if (typeof raw !== "string" || !ISO.test(raw) || Number.isNaN(Date.parse(raw))) return { error: "Choose when it should be published" };
  const at = new Date(raw);
  if (at.getTime() < now + MIN_AHEAD_MS) return { error: "Choose a time at least a minute from now" };
  if (at.getTime() > now + MAX_AHEAD_MS) return { error: "Posts can be scheduled up to 90 days ahead" };
  return { value: at };
}

const toPublic = (s) => ({
  id: s._id,
  content: s.content,
  imageUrl: s.imageUrl ?? null,
  imageAspect: s.imageAspect ?? null,
  imageZoom: s.imageZoom ?? null,
  imagePosition: s.imagePosition ?? null,
  imageAlt: s.imageAlt ?? "",
  poll: s.poll?.options?.length ? { options: s.poll.options, days: s.poll.days } : null,
  isAiText: s.isAiText === true,
  isAiImage: s.isAiImage === true,
  publishAt: s.publishAt,
  failed: s.status === "failed",
  failure: s.status === "failed" ? s.failure : "",
  createdAt: s.createdAt,
});

const mineById = async (id, userId) => (mongoose.isValidObjectId(id) ? ScheduledPost.findOne({ _id: id, author: userId }) : null);

// Yours, in the order they will go out.
scheduledPostsRouter.get("/", async (req, res) => {
  const rows = await ScheduledPost.find({ author: req.user.id }).sort({ publishAt: 1, _id: 1 }).limit(MAX_PENDING + 5);
  res.json({ posts: rows.map(toPublic) });
});

// Schedule a post: what POST /posts takes, and `publishAt`.
scheduledPostsRouter.post("/", async (req, res) => {
  const body = req.body ?? {};
  const when = readTime(body.publishAt);
  if (when.error) return bad(res, when.error);
  const text = checkText(body.content, MAX_POST, "Posts");
  if (text.error) return bad(res, text.error);
  const { framing, error: framingError } = readFraming(body);
  if (framingError) return bad(res, framingError);
  const hasPicture = body.imageUrl !== undefined && body.imageUrl !== null && body.imageUrl !== "";
  if (hasPicture && (typeof body.imageUrl !== "string" || body.imageUrl.length > 2000)) return bad(res, "The picture must be one you uploaded");
  const alt = hasPicture ? readAlt(body.imageAlt) : { value: "" };
  if (alt.error) return bad(res, alt.error);
  const asked = readPoll(body.poll);
  if (asked.error) return bad(res, asked.error);
  if ((await ScheduledPost.countDocuments({ author: req.user.id })) >= MAX_PENDING) return bad(res, `You can have up to ${MAX_PENDING} scheduled posts — publish or remove one first`, 409);
  if (!(await createLimit.allow(req.user.id))) {
    res.set("Retry-After", String(createLimit.windowSeconds));
    return bad(res, "You've scheduled a lot of posts today — try again tomorrow.", 429);
  }
  const created = await ScheduledPost.create({
    author: req.user.id,
    content: text.value,
    ...(hasPicture ? { imageUrl: body.imageUrl, ...framing, imageAlt: alt.value } : {}),
    ...(asked.poll ? { poll: { options: asked.poll.options, days: body.poll.days ?? 1 } } : {}),
    isAiText: body.isAiText === true,
    isAiImage: hasPicture && body.isAiImage === true,
    publishAt: when.value,
  });
  res.status(201).json({ post: toPublic(created) });
});

// Change the words, the picture's description or the time. A post that couldn't be published goes back to waiting when it is given a new time.
scheduledPostsRouter.patch("/:id", async (req, res) => {
  const item = await mineById(req.params.id, req.user.id);
  if (!item || item.status === "publishing") return notFound(res);
  const body = req.body ?? {};
  const changes = {};
  if (body.content !== undefined) {
    const text = checkText(body.content, MAX_POST, "Posts");
    if (text.error) return bad(res, text.error);
    changes.content = text.value;
  }
  if (body.imageAlt !== undefined) {
    if (!item.imageUrl) return bad(res, "That post has no picture");
    const alt = readAlt(body.imageAlt);
    if (alt.error) return bad(res, alt.error);
    changes.imageAlt = alt.value;
  }
  if (body.publishAt !== undefined) {
    const when = readTime(body.publishAt);
    if (when.error) return bad(res, when.error);
    changes.publishAt = when.value;
    if (item.status === "failed") Object.assign(changes, { status: "scheduled", failure: "" });
  }
  if (!Object.keys(changes).length) return bad(res, "Nothing to change");
  if (!(await allowEdit(req, res))) return;
  const updated = await ScheduledPost.findOneAndUpdate({ _id: item._id, author: req.user.id, status: { $ne: "publishing" } }, { $set: changes }, { new: true });
  if (!updated) return notFound(res);
  res.json({ post: toPublic(updated) });
});

// Publish it now.
scheduledPostsRouter.post("/:id/publish", async (req, res) => {
  const result = await publishNow(req.params.id, req.user.id);
  if (result.error) return bad(res, result.error, result.status);
  await result.post.populate("author");
  res.status(201).json({ post: await toPublicPost(result.post, 0, req.user.id) });
});

// Take it back (its picture goes too, unless something else uses it).
scheduledPostsRouter.delete("/:id", async (req, res) => {
  const item = await mineById(req.params.id, req.user.id);
  if (!item) return notFound(res);
  await removeScheduledPost(item);
  res.status(204).end();
});
