import { Router } from "express";
import mongoose from "mongoose";
import { BlogEntry } from "../models/BlogEntry.js";
import { BlogComment } from "../models/BlogComment.js";
import { Notification } from "../models/Notification.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicComment } from "../utils/serialize.js";
import { assertVisible, blockedUserIds } from "../utils/visibility.js";
import { MAX_COMMENT, allowEdit, cursorFilter } from "../utils/textInput.js";
import { checkComment } from "../utils/commentInput.js";
import { createLimiter } from "../utils/rateLimit.js";
import { releasePictures } from "../services/commentPictures.js";

// Comments on blog entries, mounted at /api/blog. Who may read or write them is whoever may read the entry (its author's profile:
// private, blocked and suspended all count), and an entry that can't be read is the same 404 as one that doesn't exist.
const PAGE = 20;
const commentLimiter = createLimiter({ name: "blog-comment-create", limit: 40, windowMs: 10 * 60 * 1000 });

export const blogCommentsRouter = Router();
blogCommentsRouter.use(requireAuth);

/** The entry and its author, if the viewer may read it; otherwise null. */
async function readableEntry(id, viewerId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const entry = await BlogEntry.findById(id).populate("author");
  if (!entry || !entry.author) return null;
  try {
    await assertVisible(entry.author, viewerId);
  } catch {
    return null;
  }
  return entry;
}

// Oldest first, twenty at a time; ?after=<comment id> asks for the ones that came after that. People you've blocked (or who blocked
// you) are left out.
blogCommentsRouter.get("/:id/comments", async (req, res) => {
  const entry = await readableEntry(req.params.id, req.user.id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  const filter = { entry: entry._id, author: { $nin: [...(await blockedUserIds(req.user.id))] } };
  const after = cursorFilter(req.query, mongoose, "after");
  if (after) filter._id = { $gt: after };
  const found = await BlogComment.find(filter).sort({ _id: 1 }).limit(PAGE + 1).populate("author");
  const comments = found.slice(0, PAGE);
  res.json({ comments: await Promise.all(comments.map((c) => toPublicComment(c, req.user.id))), hasMore: found.length > PAGE });
});

blogCommentsRouter.post("/:id/comments", async (req, res) => {
  const entry = await readableEntry(req.params.id, req.user.id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });

  const text = await checkComment(req.body, { userId: req.user.id, max: MAX_COMMENT, label: "Comments" });
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await commentLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(commentLimiter.windowSeconds));
    return res.status(429).json({ error: "You're commenting too fast — try again in a few minutes." });
  }

  let comment = await BlogComment.create({ entry: entry._id, author: req.user.id, content: text.value.content, imageUrl: text.value.imageUrl ?? null });
  comment = await comment.populate("author");
  if (String(entry.author._id) !== req.user.id) {
    await Notification.create({ recipient: entry.author._id, type: "blog_comment", payload: { entryId: String(entry._id), commentId: String(comment._id), actorId: req.user.id, title: entry.title } });
  }
  res.status(201).json({ comment: await toPublicComment(comment, req.user.id) });
});

// Change your own comment (its words, or take its picture off). Marked as edited.
blogCommentsRouter.patch("/comments/:commentId", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.commentId)) return res.status(404).json({ error: "Comment not found" });
  const comment = await BlogComment.findById(req.params.commentId);
  if (!comment || String(comment.author) !== req.user.id) return res.status(404).json({ error: "Comment not found" });
  const text = await checkComment(req.body, { userId: req.user.id, max: MAX_COMMENT, label: "Comments", current: comment });
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await allowEdit(req, res))) return;
  const takenOff = text.value.imageUrl === null && comment.imageUrl ? comment.imageUrl : null;
  if ((text.value.content !== undefined && text.value.content !== comment.content) || takenOff) {
    if (text.value.content !== undefined) comment.content = text.value.content;
    if (takenOff) comment.imageUrl = null;
    comment.editedAt = new Date();
    await comment.save();
    if (takenOff) await releasePictures([{ author: comment.author, imageUrl: takenOff }]);
  }
  await comment.populate("author");
  res.json({ comment: await toPublicComment(comment, req.user.id) });
});

// The person who wrote it, or the author of the entry it is on (it is their page), can take a comment down.
blogCommentsRouter.delete("/comments/:commentId", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.commentId)) return res.status(404).json({ error: "Comment not found" });
  const comment = await BlogComment.findById(req.params.commentId);
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  const entry = await BlogEntry.findById(comment.entry).select("author");
  const isAuthor = String(comment.author) === req.user.id;
  const isEntryAuthor = entry ? String(entry.author) === req.user.id : false;
  if (!isAuthor && !isEntryAuthor) return res.status(404).json({ error: "Comment not found" });
  await comment.deleteOne();
  await releasePictures([comment]);
  res.status(204).end();
});
