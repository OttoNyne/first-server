import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// The record of what moderators did, kept so decisions can be reviewed. It holds identifiers and the moderator's own note, never the
// content that was removed.
const moderationActionSchema = new mongoose.Schema(
  {
    admin: { type: ObjectId, ref: "User", required: true },
    targetType: { type: String, required: true },
    targetId: { type: ObjectId, required: true },
    // The author of the content, or the account itself for a user report.
    subject: { type: ObjectId, ref: "User", default: null },
    action: { type: String, enum: ["dismissed", "removed", "suspended", "removed_and_suspended", "unsuspended", "verified", "unverified"], required: true },
    note: { type: String, default: "", maxlength: 500 },
    reportCount: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

moderationActionSchema.index({ createdAt: -1 });

export const ModerationAction = mongoose.model("ModerationAction", moderationActionSchema);
