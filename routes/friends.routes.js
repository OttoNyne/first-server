import { Router } from "express";
import { Friendship } from "../models/Friendship.js";
import { Block } from "../models/Block.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";

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
  res.json({ friends: await Promise.all(friends.map((f) => toPublicUser(f, req.user.id))) });
});

friendsRouter.get("/requests", async (req, res) => {
  const requests = await Friendship.find({ addressee: req.user.id, status: "pending" }).populate(
    "requester"
  );
  res.json({
    requests: await Promise.all(
      requests.map(async (r) => ({
        id: r._id,
        createdAt: r.createdAt,
        requester: await toPublicUser(r.requester, req.user.id),
      }))
    ),
  });
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
