import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// A live a host has planned for later. Friends (and anyone who can see the host) can ask to be reminded; a reminder goes
// out shortly before the start time. When the host really goes live they can say which plan it was, which closes the plan.
// Old plans are deleted a couple of days after they were due.
const scheduledLiveSchema = new mongoose.Schema(
  {
    host: { type: ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 80 },
    startsAt: { type: Date, required: true },
    reminders: [{ type: ObjectId, ref: "User" }],
    status: { type: String, enum: ["scheduled", "started", "cancelled"], default: "scheduled" },
    liveId: { type: ObjectId, ref: "LiveSession", default: null },
    // When the "starting soon" reminders were sent (once only).
    remindedAt: { type: Date, default: null },
    expireAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);
scheduledLiveSchema.index({ status: 1, startsAt: 1 });
scheduledLiveSchema.index({ host: 1, status: 1 });

export const ScheduledLive = mongoose.model("ScheduledLive", scheduledLiveSchema);
