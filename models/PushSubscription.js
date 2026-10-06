import mongoose from "mongoose";

// One browser or phone that has agreed to get push notifications for an account. The endpoint is the address of the browser maker's push
// service (always one of the known ones, see utils/pushInput.js); the two keys are what lets the server encrypt a message so only that
// browser can read it. A device belongs to whoever signed in on it last.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 700 },
    p256dh: { type: String, required: true, maxlength: 200 },
    auth: { type: String, required: true, maxlength: 50 },
    // What kind of browser it is, for the person's own list of devices and nothing else.
    userAgent: { type: String, default: "", maxlength: 200 },
  },
  { timestamps: true }
);

pushSubscriptionSchema.index({ user: 1, createdAt: 1 });

export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);
