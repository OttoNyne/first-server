import mongoose from "mongoose";

const groupMembershipSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["member", "admin"], default: "member" },
  },
  { timestamps: { createdAt: "joinedAt", updatedAt: false } }
);

groupMembershipSchema.index({ group: 1, user: 1 }, { unique: true });

export const GroupMembership = mongoose.model("GroupMembership", groupMembershipSchema);
