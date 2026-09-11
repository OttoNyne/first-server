import mongoose from "mongoose";

const topFriendSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  target: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  position: { type: Number, required: true },
});

topFriendSchema.index({ owner: 1, target: 1 }, { unique: true });

export const TopFriend = mongoose.model("TopFriend", topFriendSchema);
