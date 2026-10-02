import mongoose from "mongoose";

export const MAX_GROUP_MESSAGE_LENGTH = 1000;

const groupMessageSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, maxlength: MAX_GROUP_MESSAGE_LENGTH },
  },
  { timestamps: true }
);

groupMessageSchema.index({ group: 1, _id: -1 });

export const GroupMessage = mongoose.model("GroupMessage", groupMessageSchema);
