import mongoose from "mongoose";

const trackSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 100 },
    // Who made it (optional, free text).
    artist: { type: String, default: "", maxlength: 80 },
    sourceType: { type: String, enum: ["upload", "youtube"], required: true },
    url: { type: String, required: true },
    position: { type: Number, required: true },
    // The one song that stands for the profile (at most one per person). Never plays by itself: it is only marked and easy to find.
    profileSong: { type: Boolean, default: false },
    // How many listeners have played it (see models/TrackPlay.js for what counts).
    plays: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

export const Track = mongoose.model("Track", trackSchema);
