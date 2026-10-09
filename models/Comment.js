import mongoose from "mongoose";

const commentSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, default: "", maxlength: 1000, required: function needsWords() { return !this.imageUrl; } },
    // One picture the author uploaded (never an address they typed). A comment has words, a picture or both.
    imageUrl: { type: String, default: null },
    // The top-level comment this one is a reply to (null for a comment that isn't a reply).
    parent: { type: mongoose.Schema.Types.ObjectId, ref: "Comment", default: null },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

commentSchema.index({ parent: 1 });

export const Comment = mongoose.model("Comment", commentSchema);
