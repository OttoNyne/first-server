import { Invite } from "../models/Invite.js";
import { Friendship } from "../models/Friendship.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";

/** A usable invite: not switched off, not expired, and with sign-ups left. */
export const usableFilter = (now = new Date()) => ({ revokedAt: null, expireAt: { $gt: now }, $expr: { $lt: ["$uses", "$maxUses"] } });

const looksLikeCode = (code) => typeof code === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(code);

/** The person behind a code that can still be used, or null — the same answer for a wrong code, an old one, a full one and a revoked one. */
export async function inviterForCode(code) {
  if (!looksLikeCode(code)) return null;
  const invite = await Invite.findOne({ code, ...usableFilter() });
  if (!invite) return null;
  return (await User.findById(invite.inviter)) ?? null;
}

/**
 * Someone has just signed up with a code: if it can still be used, count the use (one atomic update, so ten people can't squeeze
 * through an invite of nine), make the two of them friends and tell the inviter. Returns the inviter, or null if the code
 * wasn't usable. A problem here never stops the sign-up.
 */
export async function redeemInvite(code, newUser) {
  if (!looksLikeCode(code)) return null;
  const invite = await Invite.findOneAndUpdate(
    { code, ...usableFilter(), inviter: { $ne: newUser._id } },
    { $inc: { uses: 1 }, $push: { joined: { user: newUser._id, at: new Date() } } },
    { new: true }
  );
  if (!invite) return null;
  const inviter = await User.findById(invite.inviter);
  if (!inviter) return null;
  await Friendship.updateOne(
    { requester: newUser._id, addressee: inviter._id },
    { $setOnInsert: { requester: newUser._id, addressee: inviter._id, status: "accepted" } },
    { upsert: true }
  );
  await Notification.create({ recipient: inviter._id, type: "invite_joined", payload: { actorId: String(newUser._id), inviteId: String(invite._id) } });
  return inviter;
}
