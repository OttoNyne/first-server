import mongoose from "mongoose";

const commentSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, maxlength: 1000 },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Comment = mongoose.model("Comment", commentSchema);
