import mongoose from "mongoose";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { ProfileComment } from "../models/ProfileComment.js";
import { MediaComment } from "../models/MediaComment.js";
import { BlogEntry } from "../models/BlogEntry.js";
import { Bulletin } from "../models/Bulletin.js";
import { GroupTopic } from "../models/GroupTopic.js";
import { GroupReply } from "../models/GroupReply.js";
import { Notification } from "../models/Notification.js";
import { Report } from "../models/Report.js";
import { ModerationAction } from "../models/ModerationAction.js";
import { User } from "../models/User.js";
import { toPublicUser } from "../utils/serialize.js";
import { deleteStoredAssetIfUnused } from "./storedAssets.js";
import { isAdminUser } from "../utils/admin.js";

export const CONTENT_TYPES = ["post", "comment", "profileComment", "blogEntry", "bulletin", "groupTopic", "groupReply", "mediaComment"];
export const REPORT_TYPES = ["user", ...CONTENT_TYPES];
const PREVIEW_CHARS = 600;
const clip = (text) => (typeof text === "string" && text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : (text ?? ""));

/**
 * What a report is about, as plain data for the review screen. `exists: false` means it has already been deleted. `author` is the
 * person responsible (the account itself for a user report). Text is returned as text; the screen draws it as text.
 */
export async function loadTarget(type, id, viewerId) {
  if (!REPORT_TYPES.includes(type) || !mongoose.isValidObjectId(id)) return { exists: false, authorId: null };
  const shape = async (authorDoc, extra) => ({
    exists: true,
    authorId: authorDoc?._id ?? null,
    preview: { type, author: authorDoc ? await toPublicUser(authorDoc, viewerId) : null, ...extra },
  });
  switch (type) {
    case "user": {
      const u = await User.findById(id);
      return u ? shape(u, { text: clip(u.bio ?? ""), title: u.displayName, link: `/u/${u.username}` }) : { exists: false, authorId: null };
    }
    case "post": {
      const p = await Post.findById(id).populate("author");
      return p ? shape(p.author, { text: clip(p.content), image: p.imageUrl ?? null, link: `/posts/${p._id}`, edited: Boolean(p.editedAt) }) : { exists: false, authorId: null };
    }
    case "comment": {
      const c = await Comment.findById(id).populate("author");
      return c ? shape(c.author, { text: clip(c.content), link: `/posts/${c.post}`, edited: Boolean(c.editedAt) }) : { exists: false, authorId: null };
    }
    case "profileComment": {
      const c = await ProfileComment.findById(id).populate("author").populate("profileOwner");
      return c ? shape(c.author, { text: clip(c.content), link: c.profileOwner ? `/u/${c.profileOwner.username}` : null, edited: Boolean(c.editedAt) }) : { exists: false, authorId: null };
    }
    case "mediaComment": {
      const c = await MediaComment.findById(id).populate("author").populate({ path: "item", populate: { path: "owner" } });
      const owner = c?.item?.owner;
      return c ? shape(c.author, { text: clip(c.content), link: owner ? `/u/${owner.username}?piece=${c.item._id}&comment=${c._id}#portfolio` : null, edited: Boolean(c.editedAt) }) : { exists: false, authorId: null };
    }
    case "blogEntry": {
      const b = await BlogEntry.findById(id).populate("author");
      return b ? shape(b.author, { title: b.title, text: clip(b.body), link: `/blog/${b._id}` }) : { exists: false, authorId: null };
    }
    case "bulletin": {
      const b = await Bulletin.findById(id).populate("author");
      return b ? shape(b.author, { title: b.title, text: clip(b.body), link: null, edited: Boolean(b.editedAt) }) : { exists: false, authorId: null };
    }
    case "groupTopic": {
      const t = await GroupTopic.findById(id).populate("author");
      return t ? shape(t.author, { title: t.title, text: clip(t.body), link: `/groups/${t.group}`, edited: Boolean(t.editedAt) }) : { exists: false, authorId: null };
    }
    case "groupReply": {
      const r = await GroupReply.findById(id).populate("author");
      return r ? shape(r.author, { text: clip(r.body), link: `/groups/${r.group}`, edited: Boolean(r.editedAt) }) : { exists: false, authorId: null };
    }
  }
  return { exists: false, authorId: null };
}

/** Deletes a piece of reported content the same way its owner deleting it would. Returns true if something was removed. */
export async function removeContent(type, id) {
  switch (type) {
    case "post": {
      const post = await Post.findById(id);
      if (!post) return false;
      await Comment.deleteMany({ post: post._id });
      await post.deleteOne();
      if (post.imageUrl) await deleteStoredAssetIfUnused({ ownerId: post.author, url: post.imageUrl });
      return true;
    }
    case "comment":
      return (await Comment.findByIdAndDelete(id)) !== null;
    case "profileComment":
      return (await ProfileComment.findByIdAndDelete(id)) !== null;
    case "mediaComment":
      return (await MediaComment.findByIdAndDelete(id)) !== null;
    case "blogEntry": {
      const entry = await BlogEntry.findByIdAndDelete(id);
      if (entry) await Notification.deleteMany({ type: "blog_post", "payload.entryId": String(entry._id) });
      return entry !== null;
    }
    case "bulletin":
      return (await Bulletin.findByIdAndDelete(id)) !== null;
    case "groupTopic": {
      const topic = await GroupTopic.findByIdAndDelete(id);
      if (topic) await GroupReply.deleteMany({ topic: topic._id });
      return topic !== null;
    }
    case "groupReply": {
      const reply = await GroupReply.findByIdAndDelete(id);
      if (reply) await GroupTopic.updateOne({ _id: reply.topic, replyCount: { $gt: 0 } }, { $inc: { replyCount: -1 } });
      return reply !== null;
    }
  }
  return false;
}

const WHAT = { post: "post", comment: "comment", profileComment: "testimonial", mediaComment: "comment on a portfolio piece", blogEntry: "blog entry", bulletin: "bulletin", groupTopic: "group topic", groupReply: "group reply" };

export async function suspendUser(userId, note) {
  await User.updateOne({ _id: userId }, { $set: { suspendedAt: new Date(), suspensionNote: note ?? "" } });
}

/**
 * A moderator's decision on everything reported about one thing. `action`: dismiss | remove | suspend | remove_and_suspend.
 * The reports are closed, the decision is logged, the people who reported are thanked (without details), and the author is told if
 * their content was removed. Returns { error } or { ok, outcome }.
 */
export async function resolveCase({ adminId, targetType, targetId, action, note }) {
  const open = await Report.find({ targetType, targetId, status: "open" });
  if (!open.length) return { error: "There are no open reports for that", status: 404 };

  const target = await loadTarget(targetType, targetId, adminId);
  const wantsRemove = action === "remove" || action === "remove_and_suspend";
  const wantsSuspend = action === "suspend" || action === "remove_and_suspend";
  const subjectId = target.authorId;

  if (wantsRemove && targetType === "user") return { error: "An account is suspended, not removed", status: 400 };
  if (wantsSuspend) {
    if (!subjectId) return { error: "There is no account to suspend: its owner may have left", status: 400 };
    if (String(subjectId) === String(adminId)) return { error: "You can't suspend your own account", status: 400 };
    const subject = await User.findById(subjectId).select("email emailVerified");
    if (isAdminUser(subject)) return { error: "An administrator can't be suspended here", status: 400 };
  }

  let removed = false;
  if (wantsRemove && target.exists) removed = await removeContent(targetType, targetId);
  if (wantsSuspend) await suspendUser(subjectId, note);

  const logged = action === "dismiss" ? "dismissed" : action === "remove" ? "removed" : action === "suspend" ? "suspended" : "removed_and_suspended";
  await Report.updateMany(
    { targetType, targetId, status: "open" },
    { $set: { status: action === "dismiss" ? "dismissed" : "reviewed", reviewedBy: adminId, reviewedAt: new Date(), action: logged, note: note ?? "" } }
  );
  await ModerationAction.create({ admin: adminId, targetType, targetId, subject: subjectId, action: logged, note: note ?? "", reportCount: open.length });

  // Thank the people who reported, without saying what was decided about whom.
  const reporters = [...new Set(open.map((r) => String(r.reporter)))];
  await Notification.insertMany(reporters.map((recipient) => ({ recipient, type: "report_resolved", payload: { outcome: action === "dismiss" ? "no_action" : "action_taken" } })));
  if (removed && subjectId && targetType !== "user") {
    await Notification.create({ recipient: subjectId, type: "content_removed", payload: { what: WHAT[targetType] ?? "content" } });
  }
  return { ok: true, outcome: logged, removed };
}

export async function liftSuspension(adminId, userId) {
  const user = await User.findOneAndUpdate({ _id: userId, suspendedAt: { $ne: null } }, { $set: { suspendedAt: null, suspensionNote: "" } });
  if (!user) return false;
  await ModerationAction.create({ admin: adminId, targetType: "user", targetId: user._id, subject: user._id, action: "unsuspended", note: "", reportCount: 0 });
  return true;
}
