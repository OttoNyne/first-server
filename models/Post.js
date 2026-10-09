import mongoose from "mongoose";
import { hashtagsIn } from "../utils/hashtags.js";

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, maxlength: 5000 },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
    imageUrl: { type: String, default: null },
    // How the picture is framed. Absent on posts made before framing existed, which show the picture as it always did.
    imageAspect: { type: String, enum: ["original", "1:1", "4:3", "16:9"] },
    imageZoom: { type: Number, min: 1, max: 3 },
    imagePosition: { type: String },
    isAiText: { type: Boolean, default: false },
    isAiImage: { type: Boolean, default: false },
    // The #hashtags in the words, lower-cased (always worked out from the content; see utils/hashtags.js).
    tags: { type: [String] },
  },
  { timestamps: true }
);

postSchema.pre("save", function () {
  if (this.isNew || this.isModified("content") || !this.tags) this.tags = hashtagsIn(this.content);
});
postSchema.index({ tags: 1, _id: -1 });

export const Post = mongoose.model("Post", postSchema);
