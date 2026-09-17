import { Router } from "express";
import { Comment } from "../models/Comment.js";
import { Post } from "../models/Post.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { toPublicComment } from "../utils/serialize.js";
import { assertVisible } from "../utils/visibility.js";

export const commentsRouter = Router();

commentsRouter.get("/posts/:postId/comments", attachUserIfPresent, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found" });
    await assertVisible(await User.findById(post.author), req.user?.id);

    const comments = await Comment.find({ post: req.params.postId }).sort("createdAt").populate("author");
    res.json({ comments: await Promise.all(comments.map((c) => toPublicComment(c, req.user?.id))) });
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

  let comment = await Comment.create({
    post: post._id,
    author: req.user.id,
    content: req.body.content,
  });
  comment = await comment.populate("author");

  if (String(post.author) !== req.user.id) {
    await Notification.create({
      recipient: post.author,
      type: "comment",
      payload: { postId: post._id, commentId: comment._id, actorId: req.user.id },
    });
  }

  res.status(201).json({ comment: await toPublicComment(comment, req.user.id) });
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
  res.status(204).end();
});
