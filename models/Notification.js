import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["friend_request", "friend_accept", "comment", "profile_comment", "group_invite", "help_offer", "help_accepted", "live_started", "message", "live_scheduled", "live_reminder", "blog_post", "invite_joined", "report_resolved", "content_removed", "media_comment", "event_created", "event_updated", "event_cancelled", "event_reminder", "friend_birthday", "blog_comment", "cs_verified", "reaction", "credit_request", "credit_accepted", "work_request", "work_reply", "mention", "follow", "repost", "reply", "call_match", "call_application", "call_answer", "project_message"],
      required: true,
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Whoever gets a notification also gets a push to their devices (see services/push.js). Every notification is made with create or
// insertMany, so these two hooks cover them all; the service is loaded when it is first needed (it needs this model) and a failure
// there never reaches the code that made the notification.
notificationSchema.pre("save", function () {
  this.$locals.isNewNotification = this.isNew;
});
// The same hook tells anyone with the site open that there is something new (see services/liveUpdates.js): a hint with nothing in it.
const tell = (docs) => import("../services/liveUpdates.js").then((m) => docs.forEach((d) => m.publish(d.recipient, "notification"))).catch((err) => console.error("Live-update hook failed:", err.message));
const push = (docs) => import("../services/push.js").then((m) => m.queuePush(docs)).catch((err) => console.error("Push hook failed:", err.message));
notificationSchema.post("save", function (doc) {
  if (doc.$locals.isNewNotification) {
    push([doc]);
    tell([doc]);
  }
});
notificationSchema.post("insertMany", function (docs) {
  push(docs);
  tell(docs);
});

export const Notification = mongoose.model("Notification", notificationSchema);
