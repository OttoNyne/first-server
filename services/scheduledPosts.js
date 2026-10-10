import mongoose from "mongoose";
import { Post } from "../models/Post.js";
import { ScheduledPost } from "../models/ScheduledPost.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { readPoll } from "../utils/polls.js";
import { canSeeProfileOf, notifyMentions } from "./mentions.js";
import { deleteStoredAssetIfUnused } from "./storedAssets.js";

// Posts people asked to be published later. A post is claimed with one atomic update before anything is made, so two runs (or two servers)
// can't both publish it, and the id the post will have is fixed at that moment, so a run that died half way is picked up again later and
// makes the same post, never a second one. Run on a timer, and also whenever someone looks at their notifications, so a server that was
// asleep catches up as soon as anyone is there.
export const MIN_AHEAD_MS = 60 * 1000;
export const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_PENDING = 20;
export const STUCK_AFTER_MS = 2 * 60 * 1000;
const AT_MOST = 50; // one run publishes at most this many
const CHECK_EVERY_MS = 15_000;
let lastCheck = 0;

const FAILURES = {
  account: "Your account couldn't post at that time.",
  poll: "The poll couldn't be published.",
  other: "This post couldn't be published.",
};

/** Make the real post from a claimed record, tell its author, and remove the record. Returns the post, or null (with the record marked failed). */
async function publish(item, now) {
  const fail = async (reason) => {
    await ScheduledPost.updateOne({ _id: item._id }, { $set: { status: "failed", failure: FAILURES[reason] ?? FAILURES.other } });
    await Notification.create({ recipient: item.author, type: "scheduled_post", payload: { failed: true } }).catch(() => {});
    return null;
  };
  const author = await User.findById(item.author);
  if (!author || author.suspendedAt) return fail("account");
  let poll = null;
  if (item.poll?.options?.length) {
    const asked = readPoll({ options: item.poll.options, days: item.poll.days }, now.getTime());
    if (asked.error) return fail("poll");
    poll = asked.poll;
  }
  let post;
  try {
    post = await Post.create({
      _id: item.postId,
      author: author._id,
      content: item.content,
      imageUrl: item.imageUrl ?? undefined,
      ...(item.imageUrl ? { imageAspect: item.imageAspect, imageZoom: item.imageZoom, imagePosition: item.imagePosition } : {}),
      imageAlt: item.imageUrl ? item.imageAlt : "",
      ...(poll ? { poll } : {}),
      isAiText: item.isAiText,
      isAiImage: item.isAiImage,
    });
  } catch (err) {
    // an earlier run made this very post and died before it finished: carry on from there
    if (err?.code === 11000) post = await Post.findById(item.postId);
    else {
      console.error("Couldn't publish a scheduled post:", err.message);
      return fail("other");
    }
  }
  if (!post) return fail("other");
  await post.populate("author");
  await notifyMentions({ text: post.content, actorId: String(author._id), url: `/posts/${post._id}`, canSee: canSeeProfileOf(post.author) }).catch(() => {});
  await Notification.create({ recipient: author._id, type: "scheduled_post", payload: { postId: String(post._id) } }).catch(() => {});
  await ScheduledPost.deleteOne({ _id: item._id });
  return post;
}

/** One claimed record gets its post id (once), whoever claims it first. */
async function withPostId(item) {
  if (item.postId) return item;
  const postId = new mongoose.Types.ObjectId();
  const updated = await ScheduledPost.findOneAndUpdate({ _id: item._id, postId: null }, { $set: { postId } }, { new: true });
  return updated ?? (await ScheduledPost.findById(item._id));
}

/** Publish every post whose time has come. `at` runs it for that moment (tests, or a deliberate catch-up); casual calls are spaced out. */
export async function publishDuePosts(at) {
  if (!at) {
    if (Date.now() - lastCheck < CHECK_EVERY_MS) return 0;
    lastCheck = Date.now();
  }
  const now = at ?? new Date();
  let published = 0;
  for (let i = 0; i < AT_MOST; i++) {
    const claimed = await ScheduledPost.findOneAndUpdate(
      { $or: [{ status: "scheduled", publishAt: { $lte: now } }, { status: "publishing", claimedAt: { $lt: new Date(now.getTime() - STUCK_AFTER_MS) } }] },
      { $set: { status: "publishing", claimedAt: now } },
      { sort: { publishAt: 1 }, new: true }
    );
    if (!claimed) break;
    try {
      const item = await withPostId(claimed);
      if (item && (await publish(item, now))) published += 1;
    } catch (err) {
      console.error("Couldn't publish a scheduled post:", err.message);
      await ScheduledPost.updateOne({ _id: claimed._id }, { $set: { status: "failed", failure: FAILURES.other } }).catch(() => {});
    }
  }
  return published;
}

/** Publish one record of this person's right now (the "Post now" button). Returns { post } or { error, status }. */
export async function publishNow(id, userId, now = new Date()) {
  if (!mongoose.isValidObjectId(id)) return { error: "Scheduled post not found", status: 404 };
  const claimed = await ScheduledPost.findOneAndUpdate({ _id: id, author: userId, status: { $in: ["scheduled", "failed"] } }, { $set: { status: "publishing", claimedAt: now, failure: "" } }, { new: true });
  if (!claimed) return { error: "Scheduled post not found", status: 404 };
  const item = await withPostId(claimed);
  const post = await publish(item, now);
  if (!post) return { error: (await ScheduledPost.findById(item._id))?.failure || FAILURES.other, status: 409 };
  return { post };
}

/** Take one away (cancelled by its author, or its author's account going): the record, and the picture if nothing else uses it. */
export async function removeScheduledPost(item) {
  await ScheduledPost.deleteOne({ _id: item._id });
  if (item.imageUrl) await deleteStoredAssetIfUnused({ ownerId: item.author, url: item.imageUrl });
}

/** Runs the check every minute for the life of the server (not started by tests, which call publishDuePosts directly). */
export function startScheduledPostTimer(everyMs = 60_000) {
  const run = () => publishDuePosts(new Date()).catch((err) => console.error("Scheduled posts check failed:", err.message));
  run(); // a server that was asleep catches up as it wakes
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return timer;
}
