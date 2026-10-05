import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// Something a person is organising for a date: a meet-up, a show, an online session. Friends are told when it is made, anyone who can
// see it can say they are going or might go, and people who said so are reminded shortly before it starts. Old events are deleted
// a couple of days after they ended.
const eventSchema = new mongoose.Schema(
  {
    host: { type: ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 1000 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, default: null },
    // In person (needs a place) or online (may have a link to join).
    kind: { type: String, enum: ["in_person", "online"], default: "in_person" },
    place: { type: String, default: "", maxlength: 120 },
    link: { type: String, default: "", maxlength: 300 },
    // Who can see it: the host's friends, or anyone who can see the host's profile.
    audience: { type: String, enum: ["friends", "public"], default: "friends" },
    // When the host last changed it (null if never).
    editedAt: { type: Date, default: null },
    // When the "starting soon" reminders were sent (once only).
    remindedAt: { type: Date, default: null },
    expireAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);
eventSchema.index({ startsAt: 1 });
eventSchema.index({ host: 1, startsAt: 1 });

export const Event = mongoose.model("Event", eventSchema);
