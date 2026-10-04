import { Router } from "express";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { Friendship } from "../models/Friendship.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicPost } from "../utils/serialize.js";
import { assertVisible, getProfileForViewer } from "../utils/visibility.js";
import mongoose from "mongoose";
import { deleteStoredAssetIfUnused } from "../services/storedAssets.js";
import { MAX_POST, allowEdit, checkText, cursorFilter } from "../utils/textInput.js";
import { createLimiter } from "../utils/rateLimit.js";

const PAGE = 20;
const postLimiter = createLimiter({ name: "post-create", limit: 20, windowMs: 10 * 60 * 1000 });

export const postsRouter = Router();
postsRouter.use(requireAuth);

async function withCommentCounts(posts, viewerId) {
  const counts = await Comment.aggregate([
    { $match: { post: { $in: posts.map((p) => p._id) } } },
    { $group: { _id: "$post", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  return Promise.all(posts.map((p) => toPublicPost(p, countMap.get(String(p._id)) || 0, viewerId)));
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
  const filter = { author: { $in: [req.user.id, ...friendIds] } };
  const before = cursorFilter(req.query, mongoose);
  if (before) filter._id = { $lt: before };
  const found = await Post.find(filter).sort({ _id: -1 }).limit(PAGE + 1).populate("author");
  const posts = found.slice(0, PAGE);

  res.json({ posts: await withCommentCounts(posts, req.user.id), hasMore: found.length > PAGE });
});

postsRouter.get("/user/:username", async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user.id);
    const filter = { author: user._id };
    const before = cursorFilter(req.query, mongoose);
    if (before) filter._id = { $lt: before };
    const found = await Post.find(filter).sort({ _id: -1 }).limit(PAGE + 1).populate("author");
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
  const post = await Post.findById(req.params.id).populate("author");
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
function readFraming(body) {
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

postsRouter.post("/", async (req, res) => {
  const { framing, error } = readFraming(req.body);
  if (error) return res.status(400).json({ error });
  const text = checkText(req.body?.content, MAX_POST, "Posts");
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await postLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(postLimiter.windowSeconds));
    return res.status(429).json({ error: "You're posting too fast — try again in a few minutes." });
  }
  const post = await Post.create({
    author: req.user.id,
    content: text.value,
    imageUrl: req.body.imageUrl,
    ...(req.body.imageUrl ? framing : {}),
    isAiText: req.body.isAiText || false,
    isAiImage: req.body.isAiImage || false,
  });
  await post.populate("author");
  res.status(201).json({ post: await toPublicPost(post, 0, req.user.id) });
});

// Change the words of your own post (the picture and its framing stay as they are). Marked as edited.
postsRouter.patch("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Post not found" });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (String(post.author) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  const text = checkText(req.body?.content, MAX_POST, "Posts");
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await allowEdit(req, res))) return;
  if (text.value !== post.content) {
    post.content = text.value;
    post.editedAt = new Date();
    await post.save();
  }
  await post.populate("author");
  const [withCount] = await withCommentCounts([post], req.user.id);
  res.json({ post: withCount });
});

postsRouter.delete("/:id", async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (String(post.author) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  await Comment.deleteMany({ post: post._id });
  await post.deleteOne();
  // An AI-generated image that only this post used would otherwise sit on
  // Cloudinary forever.
  if (post.imageUrl) await deleteStoredAssetIfUnused({ ownerId: post.author, url: post.imageUrl });
  res.status(204).end();
});
