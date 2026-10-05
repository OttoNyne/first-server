import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    targetType: { type: String, enum: ["user", "post", "comment", "profileComment", "blogEntry", "bulletin", "groupTopic", "groupReply", "mediaComment"], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: ["open", "reviewed", "dismissed"], default: "open" },
    // Set when a moderator decides (see services/moderation.js).
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    action: { type: String, default: null },
    note: { type: String, default: "", maxlength: 500 },
  },
  { timestamps: true }
);

export const Report = mongoose.model("Report", reportSchema);
