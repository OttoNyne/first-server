import mongoose from "mongoose";

// One person's answer in a post's poll: which option (its place in the list). A vote is final, and each person has one.
const pollVoteSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    option: { type: Number, required: true, min: 0, max: 3 },
  },
  { timestamps: true }
);

pollVoteSchema.index({ post: 1, user: 1 }, { unique: true });
pollVoteSchema.index({ user: 1 });

export const PollVote = mongoose.model("PollVote", pollVoteSchema);
