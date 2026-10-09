import { Router } from "express";
import mongoose from "mongoose";
import { MediaItem } from "../models/MediaItem.js";
import { MediaComment } from "../models/MediaComment.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { toPublicComment } from "../utils/serialize.js";
import { assertVisible, blockedUserIds } from "../utils/visibility.js";
import { canSeeProfileOf, notifyMentions } from "../services/mentions.js";
import { notifyReply, removeReplies, resolveParent } from "../utils/commentReplies.js";
import { MAX_COMMENT, allowEdit, cursorFilter } from "../utils/textInput.js";
import { checkComment } from "../utils/commentInput.js";
import { releasePictures } from "../services/commentPictures.js";
import { createLimiter } from "../utils/rateLimit.js";

// Comments on portfolio pieces, mounted at /api/media. Who may read or write them is whoever may see the piece (its owner's
// profile: private, blocked and suspended all count), and a piece that can't be seen is the same 404 as one that doesn't exist.
const PAGE = 20;
const commentLimiter = createLimiter({ name: "media-comment-create", limit: 40, windowMs: 10 * 60 * 1000 });

export const mediaCommentsRouter = Router();

/** The piece and its owner, if the viewer may see it; otherwise null. */
async function visiblePiece(id, viewerId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const item = await MediaItem.findById(id);
  if (!item) return null;
  const owner = await User.findById(item.owner);
  try {
    await assertVisible(owner, viewerId);
  } catch {
    return null;
  }
  return { item, owner };
}

mediaCommentsRouter.get("/:id/comments", attachUserIfPresent, async (req, res) => {
  const piece = await visiblePiece(req.params.id, req.user?.id);
  if (!piece) return res.status(404).json({ error: "Media item not found" });

  // Oldest first, twenty at a time; ?after=<comment id> asks for the ones that came after that. People you've blocked
  // (or who blocked you) are left out.
  const filter = { item: piece.item._id };
  const after = cursorFilter(req.query, mongoose, "after");
  if (after) filter._id = { $gt: after };
  if (req.user) filter.author = { $nin: [...(await blockedUserIds(req.user.id))] };
  const found = await MediaComment.find(filter).sort({ _id: 1 }).limit(PAGE + 1).populate("author");
  const comments = found.slice(0, PAGE);
  res.json({ comments: await Promise.all(comments.map((c) => toPublicComment(c, req.user?.id))), hasMore: found.length > PAGE });
});

mediaCommentsRouter.post("/:id/comments", requireAuth, async (req, res) => {
  const piece = await visiblePiece(req.params.id, req.user.id);
  if (!piece) return res.status(404).json({ error: "Media item not found" });

  const text = await checkComment(req.body, { userId: req.user.id, max: MAX_COMMENT, label: "Comments" });
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await commentLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(commentLimiter.windowSeconds));
    return res.status(429).json({ error: "You're commenting too fast — try again in a few minutes." });
  }

  const parent = await resolveParent(MediaComment, req.body?.parent, { item: piece.item._id });
  if (parent.error) return res.status(400).json({ error: parent.error });
  let comment = await MediaComment.create({ item: piece.item._id, parent: parent.value, author: req.user.id, content: text.value.content, imageUrl: text.value.imageUrl ?? null });
  comment = await comment.populate("author");

  if (String(piece.owner._id) !== req.user.id) {
    await Notification.create({
      recipient: piece.owner._id,
      type: "media_comment",
      payload: { mediaId: piece.item._id, commentId: comment._id, actorId: req.user.id },
    });
  }
  await notifyMentions({ text: comment.content, actorId: req.user.id, url: `/u/${piece.owner.username}?piece=${piece.item._id}&comment=${comment._id}#portfolio`, canSee: canSeeProfileOf(piece.owner), skip: [piece.owner._id] });
  await notifyReply({ replyTo: parent.replyTo, actorId: req.user.id, url: `/u/${piece.owner.username}?piece=${piece.item._id}&comment=${comment._id}#portfolio`, skip: [piece.owner._id] });
  res.status(201).json({ comment: await toPublicComment(comment, req.user.id) });
});

// Change your own comment. Marked as edited.
mediaCommentsRouter.patch("/comments/:commentId", requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.commentId)) return res.status(404).json({ error: "Comment not found" });
  const comment = await MediaComment.findById(req.params.commentId);
  if (!comment || String(comment.author) !== req.user.id) return res.status(404).json({ error: "Comment not found" });
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
  const onPiece = await MediaItem.findById(comment.item).select("owner");
  const pieceOwner = onPiece ? await User.findById(onPiece.owner) : null;
  if (pieceOwner) await notifyMentions({ text: comment.content, before: beforeText, actorId: req.user.id, url: `/u/${pieceOwner.username}?piece=${comment.item}&comment=${comment._id}#portfolio`, canSee: canSeeProfileOf(pieceOwner) });
  res.json({ comment: await toPublicComment(comment, req.user.id) });
});

// The person who wrote it, or the owner of the piece it is on (it is their page), can take a comment down.
mediaCommentsRouter.delete("/comments/:commentId", requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.commentId)) return res.status(404).json({ error: "Comment not found" });
  const comment = await MediaComment.findById(req.params.commentId);
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  const item = await MediaItem.findById(comment.item).select("owner");
  const isAuthor = String(comment.author) === req.user.id;
  const isOwner = item ? String(item.owner) === req.user.id : false;
  if (!isAuthor && !isOwner) return res.status(404).json({ error: "Comment not found" });
  await comment.deleteOne();
  await releasePictures([comment]);
  await removeReplies(MediaComment, comment);
  res.status(204).end();
});
