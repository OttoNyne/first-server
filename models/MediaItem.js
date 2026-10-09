import mongoose from "mongoose";
import { hashtagsIn } from "../utils/hashtags.js";

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
    // The #hashtags in the caption, lower-cased (always worked out from the caption; see utils/hashtags.js).
    tags: { type: [String] },
  },
  { timestamps: true }
);

mediaItemSchema.pre("save", function () {
  if (this.isNew || this.isModified("caption") || !this.tags) this.tags = hashtagsIn(this.caption);
});
mediaItemSchema.index({ tags: 1, _id: -1 });

export const MediaItem = mongoose.model("MediaItem", mediaItemSchema);
