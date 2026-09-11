import { Router } from "express";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { Friendship } from "../models/Friendship.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicPost } from "../utils/serialize.js";
import { getProfileForViewer } from "../utils/visibility.js";

export const postsRouter = Router();
postsRouter.use(requireAuth);

async function withCommentCounts(posts) {
  const counts = await Comment.aggregate([
    { $match: { post: { $in: posts.map((p) => p._id) } } },
    { $group: { _id: "$post", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  return posts.map((p) => toPublicPost(p, countMap.get(String(p._id)) || 0));
}

postsRouter.get("/feed", async (req, res) => {
  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.id }, { addressee: req.user.id }],
  });
  const friendIds = friendships.map((f) =>
    String(f.requester) === req.user.id ? f.addressee : f.requester
  );

  const posts = await Post.find({ author: { $in: [req.user.id, ...friendIds] } })
    .sort("-createdAt")
    .limit(50)
    .populate("author");

  res.json({ posts: await withCommentCounts(posts) });
});

postsRouter.get("/user/:username", async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user.id);
    const posts = await Post.find({ author: user._id }).sort("-createdAt").populate("author");
    res.json({ posts: await withCommentCounts(posts) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

postsRouter.post("/", async (req, res) => {
  const post = await Post.create({
    author: req.user.id,
    content: req.body.content,
    imageUrl: req.body.imageUrl,
    isAiText: req.body.isAiText || false,
    isAiImage: req.body.isAiImage || false,
  });
  await post.populate("author");
  res.status(201).json({ post: toPublicPost(post, 0) });
});

postsRouter.delete("/:id", async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (String(post.author) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  await post.deleteOne();
  res.status(204).end();
});
