import mongoose from "mongoose";

const profileCommentSchema = new mongoose.Schema(
  {
    profileOwner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, maxlength: 1000 },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const ProfileComment = mongoose.model("ProfileComment", profileCommentSchema);
