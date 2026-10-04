import mongoose from "mongoose";

// A named group of a person's portfolio pieces ("Sketchbook 2026"). It holds no pictures itself: each piece says which album,
// if any, it is in (MediaItem.album). Deleting an album leaves its pieces in the portfolio.
const albumSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 60 },
  },
  { timestamps: true }
);

albumSchema.index({ owner: 1, createdAt: 1 });

export const Album = mongoose.model("Album", albumSchema);
