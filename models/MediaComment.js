import mongoose from "mongoose";

// A comment on one of someone's portfolio pieces (a picture, video or track).
const mediaCommentSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, default: "", maxlength: 1000, required: function needsWords() { return !this.imageUrl; } },
    // One picture the author uploaded (never an address they typed). A comment has words, a picture or both.
    imageUrl: { type: String, default: null },
    // The top-level comment this one is a reply to (null for a comment that isn't a reply).
    parent: { type: mongoose.Schema.Types.ObjectId, ref: "MediaComment", default: null },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

mediaCommentSchema.index({ parent: 1 });

// A piece's comments, oldest first, a page at a time.
mediaCommentSchema.index({ item: 1, _id: 1 });

export const MediaComment = mongoose.model("MediaComment", mediaCommentSchema);
