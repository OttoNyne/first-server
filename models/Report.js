import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    targetType: { type: String, enum: ["user", "post", "comment", "profileComment", "blogEntry", "bulletin", "groupTopic", "groupReply", "mediaComment", "event", "blogComment", "piece", "processStep", "call", "callApplication", "projectMessage", "critique", "critiqueNote"], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: ["open", "reviewed", "dismissed"], default: "open" },
    // Set when a moderator decides (see services/moderation.js).
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    action: { type: String, default: null },
    note: { type: String, default: "", maxlength: 500 },
    // When the moderators were emailed about this report (see services/reportAlerts.js); null until they have been.
    alertedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

reportSchema.index({ alertedAt: -1 });

export const Report = mongoose.model("Report", reportSchema);
