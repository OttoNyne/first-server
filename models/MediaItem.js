import mongoose from "mongoose";

const mediaItemSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    url: { type: String, required: true },
    type: { type: String, enum: ["image", "audio", "video", "embed"], required: true },
    caption: { type: String, default: null },
    isAiImage: { type: Boolean, default: false },
    // Videos: where playback begins (a linked video plays as a one-minute window
    // from here) and, for uploaded videos, the measured length in seconds.
    startSeconds: { type: Number, default: 0, min: 0 },
    durationSeconds: { type: Number },
    // The album this piece is in, if any (see models/Album.js).
    album: { type: mongoose.Schema.Types.ObjectId, ref: "Album", default: null },
  },
  { timestamps: true }
);

export const MediaItem = mongoose.model("MediaItem", mediaItemSchema);
