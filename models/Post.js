import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true },
    imageUrl: { type: String, default: null },
    // How the picture is framed. Absent on posts made before framing existed, which show the picture as it always did.
    imageAspect: { type: String, enum: ["original", "1:1", "4:3", "16:9"] },
    imageZoom: { type: Number, min: 1, max: 3 },
    imagePosition: { type: String },
    isAiText: { type: Boolean, default: false },
    isAiImage: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Post = mongoose.model("Post", postSchema);
