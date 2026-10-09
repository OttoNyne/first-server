import mongoose from "mongoose";

// One person following another's public profile: their posts show up in the follower's feed. One-way (unlike a friendship), needs no yes
// from the person followed, and only works while the profile is public.
const followSchema = new mongoose.Schema(
  {
    follower: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    following: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

followSchema.index({ follower: 1, following: 1 }, { unique: true });
followSchema.index({ following: 1, createdAt: -1 });
followSchema.index({ follower: 1, createdAt: -1 });

export const Follow = mongoose.model("Follow", followSchema);
