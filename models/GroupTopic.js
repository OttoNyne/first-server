import mongoose from "mongoose";

export const MAX_TOPIC_TITLE = 100;
export const MAX_TOPIC_BODY = 2000;

// A discussion topic on a group's board: a title and an opening post. Members only (see routes/groupBoard.routes.js).
const groupTopicSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: MAX_TOPIC_TITLE },
    body: { type: String, required: true, maxlength: MAX_TOPIC_BODY },
    // A group admin can pin a few topics to the top.
    pinned: { type: Boolean, default: false },
    replyCount: { type: Number, default: 0, min: 0 },
    // The topic's own time at first, then the time of its latest reply: busy topics rise.
    lastActivityAt: { type: Date, required: true },
  },
  { timestamps: true }
);

groupTopicSchema.index({ group: 1, pinned: -1, lastActivityAt: -1 });
groupTopicSchema.index({ author: 1 });

export const GroupTopic = mongoose.model("GroupTopic", groupTopicSchema);
