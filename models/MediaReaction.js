import mongoose from "mongoose";

// One like (+1) or dislike (-1) per user per portfolio item.
const mediaReactionSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    value: { type: Number, enum: [1, -1], required: true },
  },
  { timestamps: true }
);
mediaReactionSchema.index({ item: 1, user: 1 }, { unique: true });
mediaReactionSchema.index({ user: 1 });

export const MediaReaction = mongoose.model("MediaReaction", mediaReactionSchema);
