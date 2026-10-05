import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["friend_request", "friend_accept", "comment", "profile_comment", "group_invite", "help_offer", "help_accepted", "live_started", "message", "live_scheduled", "live_reminder", "blog_post", "invite_joined", "report_resolved", "content_removed", "media_comment"],
      required: true,
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Notification = mongoose.model("Notification", notificationSchema);
