import mongoose from "mongoose";

const profileCommentSchema = new mongoose.Schema(
  {
    profileOwner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, default: "", maxlength: 1000, required: function needsWords() { return !this.imageUrl; } },
    // One picture the author uploaded (never an address they typed). A comment has words, a picture or both.
    imageUrl: { type: String, default: null },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const ProfileComment = mongoose.model("ProfileComment", profileCommentSchema);
