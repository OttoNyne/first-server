import mongoose from "mongoose";
import { Notification } from "../models/Notification.js";
import { areBlocked } from "./visibility.js";
import { releasePictures } from "../services/commentPictures.js";

// Replies in a comment thread: one level, like most sites. A reply names the top-level comment it belongs to (`parent`); replying to a reply
// attaches to that same top-level comment, so a thread is always a comment and the replies under it.

/**
 * Which comment a new comment is a reply to. `rawParent` is what was sent (nothing means it isn't a reply), `model` the kind of comment and
 * `scope` what ties it to the same thing (for example { post: id }), so a reply can't point at a comment on somewhere else.
 * Returns { value } (the top-level comment's id, or null) and `replyTo` (the comment that was answered), or { error }.
 */
export async function resolveParent(model, rawParent, scope) {
  if (rawParent === undefined || rawParent === null || rawParent === "") return { value: null, replyTo: null };
  if (typeof rawParent !== "string" || !mongoose.isValidObjectId(rawParent)) return { error: "That comment can't be replied to" };
  const replyTo = await model.findOne({ _id: rawParent, ...scope });
  if (!replyTo) return { error: "That comment can't be replied to" };
  return { value: replyTo.parent ?? replyTo._id, replyTo };
}

/** Tell the person whose comment was answered, unless it is the writer, they are blocked either way, or they are already being told about this another way. */
export async function notifyReply({ replyTo, actorId, url, skip = [] }) {
  try {
    if (!replyTo || String(replyTo.author) === String(actorId) || skip.map(String).includes(String(replyTo.author))) return;
    if (await areBlocked(actorId, replyTo.author)) return;
    await Notification.create({ recipient: replyTo.author, type: "reply", payload: { actorId: String(actorId), url } });
  } catch (err) {
    console.error("Couldn't notify of a reply:", err.message);
  }
}

/** Taking a comment down takes its replies with it (and their pictures). */
export async function removeReplies(model, comment) {
  const replies = await model.find({ parent: comment._id, imageUrl: { $ne: null } });
  await model.deleteMany({ parent: comment._id });
  await releasePictures(replies);
}
