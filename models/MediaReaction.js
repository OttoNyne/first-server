import mongoose from "mongoose";

// The old like (+1) / dislike (-1) on a portfolio piece. Nothing writes to this any more: reactions are in models/Reaction.js. It is kept only
// so services/reactionMigration.js can carry the old likes over (as the 👍 reaction) and clear this collection out.
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
