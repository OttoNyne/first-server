import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// One voice-only live broadcast. It counts as live only while its host keeps
// sending heartbeats (a closed tab or dropped connection ends it on its own).
// Ended sessions are deleted a day later by the TTL index.
const liveSessionSchema = new mongoose.Schema(
  {
    host: { type: ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 80 },
    status: { type: String, enum: ["live", "ended"], default: "live" },
    lastHeartbeat: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    expireAt: { type: Date, expires: 0 },
  },
  { timestamps: true }
);
liveSessionSchema.index({ status: 1, lastHeartbeat: -1 });
liveSessionSchema.index({ host: 1, status: 1 });

// Someone listening. "Active" means they pinged recently; the TTL cleans up the rest.
const liveListenerSchema = new mongoose.Schema({
  session: { type: ObjectId, ref: "LiveSession", required: true },
  user: { type: ObjectId, ref: "User", required: true },
  lastSeen: { type: Date, required: true },
  expireAt: { type: Date, required: true, expires: 0 },
});
liveListenerSchema.index({ session: 1, user: 1 }, { unique: true });

// Short-lived WebRTC handshake messages passed between the host and one listener
// through the server (offer, answer, ICE candidates). They live a few minutes at most.
const liveSignalSchema = new mongoose.Schema({
  session: { type: ObjectId, ref: "LiveSession", required: true },
  from: { type: ObjectId, ref: "User", required: true },
  to: { type: ObjectId, ref: "User", required: true },
  kind: { type: String, enum: ["offer", "answer", "ice"], required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  expireAt: { type: Date, required: true, expires: 0 },
});
liveSignalSchema.index({ session: 1, to: 1, _id: 1 });

const liveCommentSchema = new mongoose.Schema(
  {
    session: { type: ObjectId, ref: "LiveSession", required: true },
    user: { type: ObjectId, ref: "User", required: true },
    body: { type: String, required: true, maxlength: 200 },
    expireAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);
liveCommentSchema.index({ session: 1, _id: 1 });

export const LiveSession = mongoose.model("LiveSession", liveSessionSchema);
export const LiveListener = mongoose.model("LiveListener", liveListenerSchema);
export const LiveSignal = mongoose.model("LiveSignal", liveSignalSchema);
export const LiveComment = mongoose.model("LiveComment", liveCommentSchema);
