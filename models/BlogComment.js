import mongoose from "mongoose";

// A comment on a blog entry. Like every comment on the site it has words, one picture the author uploaded, or both.
const blogCommentSchema = new mongoose.Schema(
  {
    entry: { type: mongoose.Schema.Types.ObjectId, ref: "BlogEntry", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, default: "", maxlength: 1000, required: function needsWords() { return !this.imageUrl; } },
    imageUrl: { type: String, default: null },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// An entry's comments, oldest first, a page at a time.
blogCommentSchema.index({ entry: 1, _id: 1 });

export const BlogComment = mongoose.model("BlogComment", blogCommentSchema);
