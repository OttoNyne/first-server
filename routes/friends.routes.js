import { Router } from "express";
import { Friendship } from "../models/Friendship.js";
import { Block } from "../models/Block.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";
import { activityFor } from "../utils/activity.js";
import { getProfileForViewer } from "../utils/visibility.js";
import { DismissedSuggestion } from "../models/DismissedSuggestion.js";
import { MAX_MUTUAL_SHOWN, mutualCounts, mutualIds, suggestionsFor } from "../utils/friendGraph.js";

export const friendsRouter = Router();
friendsRouter.use(requireAuth);

friendsRouter.get("/", async (req, res) => {
  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.id }, { addressee: req.user.id }],
  })
    .populate("requester")
    .populate("addressee");

  const friends = friendships.map((f) =>
    String(f.requester._id) === req.user.id ? f.addressee : f.requester
  );
  res.json({ friends: await Promise.all(friends.map(async (f) => ({ ...(await toPublicUser(f, req.user.id)), ...activityFor(f, req.user.id, true) }))) });
});

friendsRouter.get("/requests", async (req, res) => {
  const requests = await Friendship.find({ addressee: req.user.id, status: "pending" }).populate(
    "requester"
  );
  // how many friends each person asking has in common with you, to help decide
  const counts = await mutualCounts(req.user.id, requests.map((r) => r.requester));
  res.json({
    requests: await Promise.all(
      requests.map(async (r) => ({
        id: r._id,
        createdAt: r.createdAt,
        requester: await toPublicUser(r.requester, req.user.id),
        mutualCount: counts.get(String(r.requester._id)) ?? 0,
      }))
    ),
  });
});

// The friends you and this person share (the number, and up to eight of them). Only for someone whose profile you may see, never
// for yourself, and nothing at all if they have switched connections off; people who have switched it off are not named.
friendsRouter.get("/mutual/:username", async (req, res) => {
  try {
    const target = await getProfileForViewer(String(req.params.username).toLowerCase(), req.user.id);
    const ids = await mutualIds(req.user.id, target);
    const people = ids.length ? await User.find({ _id: { $in: ids.slice(0, MAX_MUTUAL_SHOWN) } }) : [];
    res.json({ count: ids.length, friends: await Promise.all(people.map((p) => toPublicUser(p, req.user.id))) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// People you may know: friends of your friends you aren't connected to, most friends in common first.
friendsRouter.get("/suggestions", async (req, res) => {
  const found = await suggestionsFor(req.user.id);
  res.json({
    suggestions: await Promise.all(
      found.map(async (s) => ({ user: await toPublicUser(s.user, req.user.id), mutualCount: s.mutualCount, mutual: await Promise.all(s.mutual.map((m) => toPublicUser(m, req.user.id))) }))
    ),
  });
});

// "Not interested": that person isn't suggested to you again. At most 500 are remembered.
friendsRouter.post("/suggestions/dismiss/:username", async (req, res) => {
  const target = await User.findOne({ username: String(req.params.username).toLowerCase() });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (String(target._id) === req.user.id) return res.status(400).json({ error: "That's you" });
  if (!(await DismissedSuggestion.exists({ owner: req.user.id, target: target._id })) && (await DismissedSuggestion.countDocuments({ owner: req.user.id })) >= 500) {
    return res.status(400).json({ error: "You've dismissed a lot of suggestions" });
  }
  await DismissedSuggestion.updateOne({ owner: req.user.id, target: target._id }, { $setOnInsert: { owner: req.user.id, target: target._id } }, { upsert: true });
  res.status(204).end();
});

friendsRouter.post("/request/:username", async (req, res) => {
  const target = await User.findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (String(target._id) === req.user.id) return res.status(400).json({ error: "Cannot friend yourself" });

  const blocked = await Block.findOne({
    $or: [
      { blocker: req.user.id, blocked: target._id },
      { blocker: target._id, blocked: req.user.id },
    ],
  });
  if (blocked) return res.status(403).json({ error: "Not allowed" });

  const existing = await Friendship.findOne({
    $or: [
      { requester: req.user.id, addressee: target._id },
      { requester: target._id, addressee: req.user.id },
    ],
  });
  if (existing) return res.status(409).json({ error: "Friend request already exists" });

  const friendship = await Friendship.create({ requester: req.user.id, addressee: target._id });
  await Notification.create({
    recipient: target._id,
    type: "friend_request",
    payload: { friendshipId: friendship._id, actorId: req.user.id },
  });

  res.status(201).json({ friendship });
});

friendsRouter.post("/accept/:requestId", async (req, res) => {
  const friendship = await Friendship.findOne({ _id: req.params.requestId, addressee: req.user.id });
  if (!friendship) return res.status(404).json({ error: "Request not found" });
  friendship.status = "accepted";
  await friendship.save();
  await Notification.create({
    recipient: friendship.requester,
    type: "friend_accept",
    payload: { friendshipId: friendship._id, actorId: req.user.id },
  });
  res.json({ friendship });
});

friendsRouter.post("/decline/:requestId", async (req, res) => {
  const friendship = await Friendship.findOne({ _id: req.params.requestId, addressee: req.user.id });
  if (!friendship) return res.status(404).json({ error: "Request not found" });
  friendship.status = "declined";
  await friendship.save();
  res.json({ friendship });
});

friendsRouter.delete("/:friendId", async (req, res) => {
  await Friendship.deleteMany({
    status: "accepted",
    $or: [
      { requester: req.user.id, addressee: req.params.friendId },
      { requester: req.params.friendId, addressee: req.user.id },
    ],
  });
  res.status(204).end();
});
