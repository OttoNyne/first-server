import mongoose from "mongoose";

export const MAX_REPLY_BODY = 1000;

// A reply in a topic on a group's board.
const groupReplySchema = new mongoose.Schema(
  {
    topic: { type: mongoose.Schema.Types.ObjectId, ref: "GroupTopic", required: true },
    group: { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, maxlength: MAX_REPLY_BODY },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

groupReplySchema.index({ topic: 1, _id: 1 });
groupReplySchema.index({ author: 1 });

export const GroupReply = mongoose.model("GroupReply", groupReplySchema);
