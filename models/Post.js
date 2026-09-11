import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true },
    imageUrl: { type: String, default: null },
    isAiText: { type: Boolean, default: false },
    isAiImage: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Post = mongoose.model("Post", postSchema);
