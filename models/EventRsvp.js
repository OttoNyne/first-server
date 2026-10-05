import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// One person's answer about one event: going or maybe. Not answering (or taking the answer back) is no document.
const eventRsvpSchema = new mongoose.Schema(
  {
    event: { type: ObjectId, ref: "Event", required: true },
    user: { type: ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["going", "maybe"], required: true },
  },
  { timestamps: true }
);
eventRsvpSchema.index({ event: 1, user: 1 }, { unique: true });
eventRsvpSchema.index({ event: 1, status: 1, _id: 1 });
eventRsvpSchema.index({ user: 1, _id: -1 });

export const EventRsvp = mongoose.model("EventRsvp", eventRsvpSchema);
