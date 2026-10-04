import { Router } from "express";
import { User } from "../models/User.js";
import { Post } from "../models/Post.js";
import { MediaItem } from "../models/MediaItem.js";
import { Friendship } from "../models/Friendship.js";
import { requireAuth } from "../middleware/auth.js";

// The getting-started checklist for a new account. Nothing here is stored per step: each step is worked out from what the person has
// really done (so it can never be out of step with their account), and the only thing remembered is whether they hid the checklist.
export const onboardingRouter = Router();
onboardingRouter.use(requireAuth);

// Only accounts this young are shown the checklist, so people who joined long before it existed aren't nagged.
export const SHOW_FOR_MS = 14 * 24 * 60 * 60 * 1000;

export const STEP_KEYS = ["email", "avatar", "bio", "portfolio", "friend", "post"];

onboardingRouter.get("/", async (req, res) => {
  const me = await User.findById(req.user.id).select("emailVerified avatarUrl bio onboardingDismissedAt createdAt");
  if (!me) return res.status(404).json({ error: "User not found" });
  const [media, friends, posts] = await Promise.all([
    MediaItem.exists({ owner: me._id }),
    Friendship.exists({ status: "accepted", $or: [{ requester: me._id }, { addressee: me._id }] }),
    Post.exists({ author: me._id }),
  ]);
  const done = {
    email: Boolean(me.emailVerified),
    avatar: Boolean(me.avatarUrl),
    bio: Boolean(me.bio && me.bio.trim()),
    portfolio: Boolean(media),
    friend: Boolean(friends),
    post: Boolean(posts),
  };
  const steps = STEP_KEYS.map((key) => ({ key, done: done[key] }));
  const allDone = steps.every((s) => s.done);
  const recent = Date.now() - new Date(me.createdAt).getTime() <= SHOW_FOR_MS;
  res.json({ steps, allDone, dismissed: Boolean(me.onboardingDismissedAt), show: recent && !allDone && !me.onboardingDismissedAt });
});

// Hide the checklist for good. Saying it again changes nothing.
onboardingRouter.post("/dismiss", async (req, res) => {
  await User.updateOne({ _id: req.user.id, onboardingDismissedAt: null }, { $set: { onboardingDismissedAt: new Date() } });
  res.status(204).end();
});
