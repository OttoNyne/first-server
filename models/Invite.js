import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

export const INVITE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_MAX_USES = 10;

// A link someone shares so a friend can join and be their friend straight away. It is deliberately limited: it expires after a
// week, works for at most 10 sign-ups, and its owner can switch it off at any time (see routes/invites.routes.js).
const inviteSchema = new mongoose.Schema(
  {
    inviter: { type: ObjectId, ref: "User", required: true },
    // 96 random bits, URL-safe. Anyone holding the link can use it, which is why it expires and is capped.
    code: { type: String, required: true, unique: true },
    maxUses: { type: Number, default: INVITE_MAX_USES },
    uses: { type: Number, default: 0 },
    revokedAt: { type: Date, default: null },
    joined: [{ _id: false, user: { type: ObjectId, ref: "User" }, at: { type: Date } }],
    expireAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

inviteSchema.index({ inviter: 1, createdAt: -1 });

export const Invite = mongoose.model("Invite", inviteSchema);
