import mongoose from "mongoose";

// A topic (a #hashtag) someone follows: what is posted about it shows under "your topics" on Explore and in their weekly summary.
// Private to the person.
const tagFollowSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tag: { type: String, required: true },
  },
  { timestamps: true }
);

tagFollowSchema.index({ user: 1, tag: 1 }, { unique: true });

export const TagFollow = mongoose.model("TagFollow", tagFollowSchema);
