import { Router } from "express";
import { Notification } from "../models/Notification.js";
import { Friendship } from "../models/Friendship.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { toPublicUser } from "../utils/serialize.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req, res) => {
  const notifications = await Notification.find({ recipient: req.user.id })
    .sort("-createdAt")
    .limit(50);

  const actorIds = notifications.map((n) => n.payload?.actorId).filter(Boolean);
  const actors = await User.find({ _id: { $in: actorIds } });
  const actorMap = new Map(actors.map((a) => [String(a._id), a]));

  const friendshipIds = notifications
    .filter((n) => n.type === "friend_request")
    .map((n) => n.payload?.friendshipId)
    .filter(Boolean);
  const friendships = await Friendship.find({ _id: { $in: friendshipIds } });
  const friendshipMap = new Map(friendships.map((f) => [String(f._id), f.status]));

  res.json({
    notifications: await Promise.all(
      notifications.map(async (n) => ({
        id: n._id,
        recipientId: n.recipient,
        type: n.type,
        payload: n.payload,
        actor: n.payload?.actorId
          ? await toPublicUser(actorMap.get(String(n.payload.actorId)), req.user.id)
          : null,
        friendshipStatus:
          n.type === "friend_request" ? friendshipMap.get(String(n.payload?.friendshipId)) ?? null : undefined,
        isRead: n.isRead,
        createdAt: n.createdAt,
      }))
    ),
  });
});

// The owner of a help request accepts an offer: the offerer is notified and
// the offer notification is marked accepted (so it can't be accepted twice).
notificationsRouter.post("/:id/accept-offer", async (req, res) => {
  const offer = await Notification.findOne({ _id: req.params.id, recipient: req.user.id, type: "help_offer" });
  if (!offer) return res.status(404).json({ error: "Offer not found" });
  if (offer.payload?.accepted) return res.status(200).json({ message: "Already accepted" });

  offer.payload = { ...offer.payload, accepted: true };
  offer.markModified("payload");
  offer.isRead = true;
  await offer.save();

  await Notification.create({
    recipient: offer.payload.actorId,
    type: "help_accepted",
    payload: { taskId: offer.payload.taskId, title: offer.payload.title, actorId: req.user.id },
  });
  res.status(201).json({ message: "Offer accepted" });
});

notificationsRouter.post("/read-all", async (req, res) => {
  await Notification.updateMany({ recipient: req.user.id, isRead: false }, { isRead: true });
  res.status(204).end();
});

notificationsRouter.post("/:id/read", async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, recipient: req.user.id }, { isRead: true });
  res.status(204).end();
});
