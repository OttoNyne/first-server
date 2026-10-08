import mongoose from "mongoose";

// A portfolio piece someone has entered in a week's creative challenge (see utils/challenges.js). One entry per person per week.
const challengeEntrySchema = new mongoose.Schema(
  {
    week: { type: String, required: true }, // "2026-W41"
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", required: true },
  },
  { timestamps: true }
);

challengeEntrySchema.index({ week: 1, user: 1 }, { unique: true });
challengeEntrySchema.index({ week: 1, createdAt: -1 });
challengeEntrySchema.index({ item: 1 });

export const ChallengeEntry = mongoose.model("ChallengeEntry", challengeEntrySchema);
