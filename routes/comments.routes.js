import { Router } from "express";
import { Comment } from "../models/Comment.js";
import { Post } from "../models/Post.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { toPublicComment } from "../utils/serialize.js";
import { assertVisible } from "../utils/visibility.js";
import { canSeeProfileOf, notifyMentions } from "../services/mentions.js";
import { notifyReply, removeReplies, resolveParent } from "../utils/commentReplies.js";
import mongoose from "mongoose";
import { MAX_COMMENT, allowEdit, cursorFilter } from "../utils/textInput.js";
import { checkComment } from "../utils/commentInput.js";
import { releasePictures } from "../services/commentPictures.js";
import { createLimiter } from "../utils/rateLimit.js";

const PAGE = 20;
const commentLimiter = createLimiter({ name: "comment-create", limit: 40, windowMs: 10 * 60 * 1000 });

export const commentsRouter = Router();

commentsRouter.get("/posts/:postId/comments", attachUserIfPresent, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found" });
    await assertVisible(await User.findById(post.author), req.user?.id);

    // Oldest first, twenty at a time; ?after=<comment id> asks for the ones that came after that.
    const filter = { post: req.params.postId };
    const after = cursorFilter(req.query, mongoose, "after");
    if (after) filter._id = { $gt: after };
    const found = await Comment.find(filter).sort({ _id: 1 }).limit(PAGE + 1).populate("author");
    const comments = found.slice(0, PAGE);
    res.json({ comments: await Promise.all(comments.map((c) => toPublicComment(c, req.user?.id))), hasMore: found.length > PAGE });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

commentsRouter.post("/posts/:postId/comments", requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  try {
    await assertVisible(await User.findById(post.author), req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const text = await checkComment(req.body, { userId: req.user.id, max: MAX_COMMENT, label: "Comments" });
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await commentLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(commentLimiter.windowSeconds));
    return res.status(429).json({ error: "You're commenting too fast — try again in a few minutes." });
  }
  const parent = await resolveParent(Comment, req.body?.parent, { post: post._id });
  if (parent.error) return res.status(400).json({ error: parent.error });
  let comment = await Comment.create({
    post: post._id,
    parent: parent.value,
    author: req.user.id,
    content: text.value.content,
    imageUrl: text.value.imageUrl ?? null,
  });
  comment = await comment.populate("author");

  if (String(post.author) !== req.user.id) {
    await Notification.create({
      recipient: post.author,
      type: "comment",
      payload: { postId: post._id, commentId: comment._id, actorId: req.user.id },
    });
  }

  await notifyMentions({ text: comment.content, actorId: req.user.id, url: `/posts/${post._id}?comment=${comment._id}`, canSee: canSeeProfileOf(await User.findById(post.author)), skip: [post.author] });
  await notifyReply({ replyTo: parent.replyTo, actorId: req.user.id, url: `/posts/${post._id}?comment=${comment._id}`, skip: [post.author] });
  res.status(201).json({ comment: await toPublicComment(comment, req.user.id) });
});

// Change your own comment. Marked as edited.
commentsRouter.patch("/comments/:id", requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Comment not found" });
  const comment = await Comment.findById(req.params.id);
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  if (String(comment.author) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  const text = await checkComment(req.body, { userId: req.user.id, max: MAX_COMMENT, label: "Comments", current: comment });
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await allowEdit(req, res))) return;
  const beforeText = comment.content;
  const takenOff = text.value.imageUrl === null && comment.imageUrl ? comment.imageUrl : null;
  if ((text.value.content !== undefined && text.value.content !== comment.content) || takenOff) {
    if (text.value.content !== undefined) comment.content = text.value.content;
    if (takenOff) comment.imageUrl = null;
    comment.editedAt = new Date();
    await comment.save();
    if (takenOff) await releasePictures([{ author: comment.author, imageUrl: takenOff }]);
  }
  await comment.populate("author");
  const commentedOn = await Post.findById(comment.post).select("author");
  if (commentedOn) await notifyMentions({ text: comment.content, before: beforeText, actorId: req.user.id, url: `/posts/${comment.post}?comment=${comment._id}`, canSee: canSeeProfileOf(await User.findById(commentedOn.author)) });
  res.json({ comment: await toPublicComment(comment, req.user.id) });
});

commentsRouter.delete("/comments/:id", requireAuth, async (req, res) => {
  const comment = await Comment.findById(req.params.id).populate("post");
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  const isAuthor = String(comment.author) === req.user.id;
  // comment.post can be null for a comment whose post was since deleted
  // (pre-cascade-delete data, or any other path that orphans a comment) —
  // only the comment's own author can still remove it in that case.
  const isPostAuthor = comment.post ? String(comment.post.author) === req.user.id : false;
  if (!isAuthor && !isPostAuthor) return res.status(403).json({ error: "Not allowed" });
  await comment.deleteOne();
  await releasePictures([comment]);
  await removeReplies(Comment, comment);
  res.status(204).end();
});
