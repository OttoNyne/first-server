import mongoose from "mongoose";

const mediaItemSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    url: { type: String, required: true },
    type: { type: String, enum: ["image", "audio", "video", "embed"], required: true },
    caption: { type: String, default: null },
    isAiImage: { type: Boolean, default: false },
    // Videos: where playback begins (a linked video plays as a 30-second window
    // from here) and, for uploaded videos, the measured length in seconds.
    startSeconds: { type: Number, default: 0, min: 0 },
    durationSeconds: { type: Number },
  },
  { timestamps: true }
);

export const MediaItem = mongoose.model("MediaItem", mediaItemSchema);
