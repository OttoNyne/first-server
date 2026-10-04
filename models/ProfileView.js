import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// One row per (profile, visitor): the last time that visitor looked at that profile. It exists only when BOTH of them have
// turned profile views on (see routes/profileViews.routes.js), and it deletes itself after 30 days.
const profileViewSchema = new mongoose.Schema({
  owner: { type: ObjectId, ref: "User", required: true },
  viewer: { type: ObjectId, ref: "User", required: true },
  lastViewedAt: { type: Date, required: true },
  expireAt: { type: Date, required: true, expires: 0 },
});

profileViewSchema.index({ owner: 1, viewer: 1 }, { unique: true });
profileViewSchema.index({ owner: 1, lastViewedAt: -1 });
profileViewSchema.index({ viewer: 1 });

export const ProfileView = mongoose.model("ProfileView", profileViewSchema);
