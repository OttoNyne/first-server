import mongoose from "mongoose";

const mediaItemSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    url: { type: String, required: true },
    type: { type: String, enum: ["image", "audio", "video", "embed"], required: true },
    caption: { type: String, default: null },
    isAiImage: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const MediaItem = mongoose.model("MediaItem", mediaItemSchema);
