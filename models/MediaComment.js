import mongoose from "mongoose";

// A comment on one of someone's portfolio pieces (a picture, video or track).
const mediaCommentSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, maxlength: 1000 },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// A piece's comments, oldest first, a page at a time.
mediaCommentSchema.index({ item: 1, _id: 1 });

export const MediaComment = mongoose.model("MediaComment", mediaCommentSchema);
