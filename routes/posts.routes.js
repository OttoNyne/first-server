import { Router } from "express";
import { Post } from "../models/Post.js";
import { User } from "../models/User.js";
import { Comment } from "../models/Comment.js";
import { Friendship } from "../models/Friendship.js";
import { followedAuthorIds } from "./follows.routes.js";
import { POST_POPULATE } from "./saves.routes.js";
import { Save } from "../models/Save.js";
import { Notification } from "../models/Notification.js";
import { savedIdsOf } from "../utils/saves.js";
import { PollVote } from "../models/PollVote.js";
import { deletePost } from "../services/removal.js";
import { mutedUserIds, postHidden, wordMatcher } from "../utils/mutes.js";
import { hasPoll, isClosed, pollTallies, publicPoll, readPoll } from "../utils/polls.js";
import { areBlocked } from "../utils/visibility.js";
import { cleanLine } from "../utils/profileFields.js";
import { requireAuth } from "../middleware/auth.js";
import { releasePictures } from "../services/commentPictures.js";
import { toPublicPost } from "../utils/serialize.js";
import { assertVisible, getProfileForViewer } from "../utils/visibility.js";
import { canSeeProfileOf, notifyMentions } from "../services/mentions.js";
import mongoose from "mongoose";
import { deleteStoredAssetIfUnused } from "../services/storedAssets.js";
import { MAX_POST, allowEdit, checkText, cursorFilter } from "../utils/textInput.js";
import { createLimiter } from "../utils/rateLimit.js";
import { checkEmoji, forgetReactions, notifyOfReaction, setReaction, summarise } from "../utils/reactions.js";

const PAGE = 20;
const FEED_SCAN = 60; // posts looked at in one go when words are muted
const FEED_ROUNDS = 4;
const postLimiter = createLimiter({ name: "post-create", limit: 20, windowMs: 10 * 60 * 1000 });

export const postsRouter = Router();
postsRouter.use(requireAuth);

export async function withCommentCounts(posts, viewerId) {
  const counts = await Comment.aggregate([
    { $match: { post: { $in: posts.map((p) => p._id) } } },
    { $group: { _id: "$post", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  const reactions = await summarise("post", posts.map((p) => p._id), viewerId);
  const saved = await savedIdsOf("post", posts.map((p) => p._id), viewerId);
  const polls = await pollTallies(posts, viewerId);
  return Promise.all(posts.map((p) => toPublicPost(p, countMap.get(String(p._id)) || 0, viewerId, reactions.get(String(p._id)), { saved: saved.has(String(p._id)), poll: polls.get(String(p._id)) })));
}

postsRouter.get("/feed", async (req, res) => {
  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.id }, { addressee: req.user.id }],
  });
  const friendIds = friendships.map((f) =>
    String(f.requester) === req.user.id ? f.addressee : f.requester
  );

  // Newest first, twenty at a time; ?before=<post id> asks for the ones older than that.
  // yourself, your friends, and the public profiles you follow
  // minus the people they muted, and the posts with words they muted
  const muted = await mutedUserIds(req.user.id);
  const authors = [req.user.id, ...friendIds, ...(await followedAuthorIds(req.user.id))].filter((id) => !muted.has(String(id)));
  const filter = { author: { $in: authors } };
  const before = cursorFilter(req.query, mongoose);
  if (before) filter._id = { $lt: before };
  const matches = wordMatcher((await User.findById(req.user.id).select("mutedWords"))?.mutedWords);
  if (!matches) {
    const found = await Post.find(filter).sort({ _id: -1 }).limit(PAGE + 1).populate(POST_POPULATE);
    return res.json({ posts: await withCommentCounts(found.slice(0, PAGE), req.user.id), hasMore: found.length > PAGE });
  }
  // with muted words, look at a few batches to fill a page
  const kept = [];
  let cursor = before;
  let exhausted = false;
  for (let round = 0; round < FEED_ROUNDS && kept.length <= PAGE; round++) {
    const found = await Post.find({ ...filter, ...(cursor ? { _id: { $lt: cursor } } : {}) }).sort({ _id: -1 }).limit(FEED_SCAN).populate(POST_POPULATE);
    for (const post of found) {
      cursor = post._id;
      if (!postHidden(post, matches)) kept.push(post);
      if (kept.length > PAGE) break;
    }
    if (found.length < FEED_SCAN) {
      exhausted = true;
      break;
    }
  }
  const posts = kept.slice(0, PAGE);
  res.json({ posts: await withCommentCounts(posts, req.user.id), hasMore: kept.length > PAGE || (!exhausted && kept.length > 0) });
});

postsRouter.get("/user/:username", async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user.id);
    const filter = { author: user._id };
    const before = cursorFilter(req.query, mongoose);
    if (before) filter._id = { $lt: before };
    const found = await Post.find(filter).sort({ _id: -1 }).limit(PAGE + 1).populate(POST_POPULATE);
    const posts = found.slice(0, PAGE);
    res.json({ posts: await withCommentCounts(posts, req.user.id), hasMore: found.length > PAGE });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// One post, for the page a notification links to. The same rule as everywhere else: if its author's profile isn't visible
// to you (private and not a friend, or blocked either way) it answers 404 exactly as if the post did not exist.
postsRouter.get("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Post not found" });
  const post = await Post.findById(req.params.id).populate(POST_POPULATE);
  if (!post || !post.author) return res.status(404).json({ error: "Post not found" });
  try {
    await assertVisible(post.author, req.user.id);
  } catch {
    return res.status(404).json({ error: "Post not found" });
  }
  const [withCount] = await withCommentCounts([post], req.user.id);
  res.json({ post: withCount });
});

// How a picture is framed: its shape, how far it is zoomed in (1 to 3 times) and which part
// of it stays in view ("x% y%", each 0-100). All optional; checked here because the browser
// controls are only a convenience.
const ASPECTS = ["original", "1:1", "4:3", "16:9"];
const POSITION = /^(\d{1,3})% (\d{1,3})%$/;
export function readFraming(body) {
  const out = {};
  if (body.imageAspect !== undefined && body.imageAspect !== null) {
    if (!ASPECTS.includes(body.imageAspect)) return { error: "Picture shape must be original, 1:1, 4:3 or 16:9" };
    out.imageAspect = body.imageAspect;
  }
  if (body.imageZoom !== undefined && body.imageZoom !== null) {
    if (typeof body.imageZoom !== "number" || !Number.isFinite(body.imageZoom) || body.imageZoom < 1 || body.imageZoom > 3) {
      return { error: "Picture zoom must be a number from 1 to 3" };
    }
    out.imageZoom = Math.round(body.imageZoom * 100) / 100;
  }
  if (body.imagePosition !== undefined && body.imagePosition !== null) {
    const m = typeof body.imagePosition === "string" ? POSITION.exec(body.imagePosition) : null;
    if (!m || Number(m[1]) > 100 || Number(m[2]) > 100) return { error: "Picture position must look like \"50% 50%\" (0-100 each)" };
    out.imagePosition = body.imagePosition;
  }
  return { framing: out };
}

export const MAX_ALT = 300;
/** A picture's description: one line of plain text up to 300 characters, or nothing. Returns { value } or { error }. */
export function readAlt(value) {
  if (value === undefined || value === null) return { value: "" };
  if (typeof value !== "string") return { error: "A picture description must be text" };
  const text = cleanLine(value);
  if ([...text].length > MAX_ALT) return { error: `A picture description can be up to ${MAX_ALT} characters` };
  return { value: text };
}

postsRouter.post("/", async (req, res) => {
  const { framing, error } = readFraming(req.body);
  if (error) return res.status(400).json({ error });
  const alt = req.body?.imageUrl ? readAlt(req.body?.imageAlt) : { value: "" };
  if (alt.error) return res.status(400).json({ error: alt.error });
  const text = checkText(req.body?.content, MAX_POST, "Posts");
  if (text.error) return res.status(400).json({ error: text.error });
  const asked = readPoll(req.body?.poll);
  if (asked.error) return res.status(400).json({ error: asked.error });
  if (!(await postLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(postLimiter.windowSeconds));
    return res.status(429).json({ error: "You're posting too fast — try again in a few minutes." });
  }
  const post = await Post.create({
    author: req.user.id,
    content: text.value,
    imageUrl: req.body.imageUrl,
    ...(req.body.imageUrl ? framing : {}),
    imageAlt: alt.value,
    ...(asked.poll ? { poll: asked.poll } : {}),
    isAiText: req.body.isAiText || false,
    isAiImage: req.body.isAiImage || false,
  });
  await post.populate("author");
  await notifyMentions({ text: post.content, actorId: req.user.id, url: `/posts/${post._id}`, canSee: canSeeProfileOf(post.author) });
  res.status(201).json({ post: await toPublicPost(post, 0, req.user.id) });
});

// Vote in a post's poll: `{ option: 0 }` is the first option. One vote each, and it is final; nobody can vote once the poll has closed. Only people who can see
// the post can vote (a private profile or a block answers 404, as for a missing poll). Answers with how the poll stands.
const voteLimiter = createLimiter({ name: "poll-vote", limit: 120, windowMs: 60 * 60 * 1000 });
postsRouter.put("/:id/poll/vote", async (req, res) => {
  const post = mongoose.isValidObjectId(req.params.id) ? await Post.findById(req.params.id).populate("author") : null;
  let visible = Boolean(post && hasPoll(post) && post.author);
  if (visible) {
    try {
      await assertVisible(post.author, req.user.id);
    } catch {
      visible = false;
    }
  }
  if (!visible) return res.status(404).json({ error: "Poll not found" });
  const option = req.body?.option;
  if (!Number.isInteger(option) || option < 0 || option >= post.poll.options.length) return res.status(400).json({ error: "Choose one of the options" });
  if (isClosed(post)) return res.status(400).json({ error: "This poll has ended" });
  if (!(await voteLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're voting too fast — try again in a bit" });
  try {
    await PollVote.create({ post: post._id, user: req.user.id, option });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "You have already voted in this poll" });
    throw err;
  }
  const tally = (await pollTallies([post], req.user.id)).get(String(post._id));
  res.status(201).json({ poll: publicPoll(post, tally) });
});

// Change the words of your own post and/or the description of its picture (the picture and its framing stay as they are). Changed words mark it as edited.
postsRouter.patch("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Post not found" });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (String(post.author) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  const wantsAlt = req.body !== undefined && req.body !== null && Object.hasOwn(req.body, "imageAlt");
  const alt = wantsAlt ? readAlt(req.body.imageAlt) : null;
  if (alt?.error) return res.status(400).json({ error: alt.error });
  if (wantsAlt && !post.imageUrl) return res.status(400).json({ error: "That post has no picture" });
  // a repost can have no words of its own; anything else must have some (unless only the picture's description is being changed)
  const text = wantsAlt && !Object.hasOwn(req.body, "content") ? { value: post.content } : post.isRepost && req.body?.content === "" ? { value: "" } : checkText(req.body?.content, MAX_POST, "Posts");
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await allowEdit(req, res))) return;
  const beforeText = post.content;
  const wordsChanged = text.value !== post.content;
  if (wordsChanged || (alt && alt.value !== post.imageAlt)) {
    if (wordsChanged) {
      post.content = text.value;
      post.editedAt = new Date();
    }
    if (alt) post.imageAlt = alt.value;
    await post.save();
  }
  await post.populate(POST_POPULATE);
  await notifyMentions({ text: post.content, before: beforeText, actorId: req.user.id, url: `/posts/${post._id}`, canSee: canSeeProfileOf(post.author) });
  const [withCount] = await withCommentCounts([post], req.user.id);
  res.json({ post: withCount });
});

// React to a post with one of the six emoji (`{emoji: "love"}`), change your reaction, or take it away (`{emoji: null}`). Visible to the same
// people as the post itself (anyone else gets the 404 a missing post gets); the author is told once about each person's first reaction.
const reactionLimit = createLimiter({ name: "reaction", limit: 300, windowMs: 60 * 60 * 1000 });
postsRouter.put("/:id/reaction", async (req, res) => {
  const emoji = checkEmoji(req.body?.emoji);
  if (emoji.error) return res.status(400).json({ error: emoji.error });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Post not found" });
  const post = await Post.findById(req.params.id).populate("author");
  if (!post || !post.author) return res.status(404).json({ error: "Post not found" });
  try {
    await assertVisible(post.author, req.user.id);
  } catch {
    return res.status(404).json({ error: "Post not found" });
  }
  if (!(await reactionLimit.allow(req.user.id))) return res.status(429).json({ error: "You're reacting too fast — try again in a bit" });
  const { created } = await setReaction({ targetType: "post", target: post._id, user: req.user.id, emoji: emoji.value });
  if (created) await notifyOfReaction({ ownerId: post.author._id, actorId: req.user.id, targetType: "post", target: post._id, emoji: emoji.value });
  res.json({ reactions: (await summarise("post", [post._id], req.user.id)).get(String(post._id)) });
});

// Share someone else's post to your own feed, with words of your own if you like: { content? }. Always shares the original (sharing a repost
// shares what it shares). Only public profiles' posts can be shared, nobody is shared to people who couldn't open it, and the author is told.
const repostLimiter = createLimiter({ name: "repost", limit: 30, windowMs: 60 * 60 * 1000 });
postsRouter.post("/:id/repost", async (req, res) => {
  const notFound = () => res.status(404).json({ error: "Post not found" });
  if (!mongoose.isValidObjectId(req.params.id)) return notFound();
  const target = await Post.findById(req.params.id).populate("author");
  if (!target?.author) return notFound();
  try {
    await assertVisible(target.author, req.user.id);
  } catch {
    return notFound();
  }
  const original = target.isRepost ? await Post.findById(target.repostOf).populate("author") : target;
  const owner = original?.author;
  if (!owner || owner.isPrivate || owner.suspendedAt || (await areBlocked(req.user.id, owner._id))) return notFound();
  if (String(owner._id) === req.user.id) return res.status(400).json({ error: "You can't share your own post" });
  let words = "";
  if (req.body?.content !== undefined && req.body.content !== null && req.body.content !== "") {
    const text = checkText(req.body.content, MAX_POST, "Posts");
    if (text.error) return res.status(400).json({ error: text.error });
    words = text.value;
  }
  if (await Post.exists({ author: req.user.id, repostOf: original._id })) return res.status(409).json({ error: "You've already shared this post" });
  if (!(await repostLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're sharing too fast — try again in a bit." });
  const shared = await Post.create({ author: req.user.id, isRepost: true, repostOf: original._id, content: words });
  await shared.populate(POST_POPULATE);
  await Notification.create({ recipient: owner._id, type: "repost", payload: { actorId: String(req.user.id), postId: String(shared._id) } }).catch(() => {});
  if (words) await notifyMentions({ text: words, actorId: req.user.id, url: `/posts/${shared._id}`, canSee: canSeeProfileOf(shared.author) });
  const [out] = await withCommentCounts([shared], req.user.id);
  res.status(201).json({ post: out });
});

// Put one of your own posts at the top of your profile (one at a time: pinning another replaces it), or take it down again.
postsRouter.put("/:id/pin", async (req, res) => {
  const post = mongoose.isValidObjectId(req.params.id) ? await Post.findById(req.params.id) : null;
  if (!post || String(post.author) !== req.user.id) return res.status(404).json({ error: "Post not found" });
  await User.updateOne({ _id: req.user.id }, { $set: { pinnedPost: post._id } });
  res.json({ pinned: true });
});

postsRouter.delete("/:id/pin", async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await User.updateOne({ _id: req.user.id, pinnedPost: req.params.id }, { $set: { pinnedPost: null } });
  res.status(204).end();
});

postsRouter.delete("/:id", async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (String(post.author) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  await deletePost(post);
  res.status(204).end();
});
