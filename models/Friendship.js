import mongoose from "mongoose";

const friendshipSchema = new mongoose.Schema(
  {
    requester: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    addressee: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
  },
  { timestamps: true }
);

friendshipSchema.index({ requester: 1, addressee: 1 }, { unique: true });

export const Friendship = mongoose.model("Friendship", friendshipSchema);
