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
    notifications: notifications.map((n) => ({
      id: n._id,
      recipientId: n.recipient,
      type: n.type,
      payload: n.payload,
      actor: n.payload?.actorId ? toPublicUser(actorMap.get(String(n.payload.actorId))) : null,
      friendshipStatus:
        n.type === "friend_request" ? friendshipMap.get(String(n.payload?.friendshipId)) ?? null : undefined,
      isRead: n.isRead,
      createdAt: n.createdAt,
    })),
  });
});

notificationsRouter.post("/read-all", async (req, res) => {
  await Notification.updateMany({ recipient: req.user.id, isRead: false }, { isRead: true });
  res.status(204).end();
});

notificationsRouter.post("/:id/read", async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, recipient: req.user.id }, { isRead: true });
  res.status(204).end();
});
