import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// A listener's play of a track, kept for a day so the same person playing a song again and again counts once a day. Only the
// total on the track is kept for good; nobody is shown who listened.
const trackPlaySchema = new mongoose.Schema({
  track: { type: ObjectId, ref: "Track", required: true },
  listener: { type: ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
});
trackPlaySchema.index({ track: 1, listener: 1 }, { unique: true });
trackPlaySchema.index({ listener: 1 });

export const TrackPlay = mongoose.model("TrackPlay", trackPlaySchema);
