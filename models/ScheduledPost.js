import mongoose from "mongoose";

// A post its author wrote now and asked the site to publish later. It is a record of its own, never a Post, so nothing that lists posts
// (the feed, a profile, Explore, search, a digest) can show it before its time: only the person who made it ever reads it, and when the
// time comes services/scheduledPosts.js makes the real Post and removes this. The words and the picture's framing are stored as they will
// be published; the poll is stored as asked (options and days) because it runs from the moment of publishing, not from now.
const scheduledPostSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, maxlength: 5000 },
    imageUrl: { type: String, default: null },
    imageAspect: { type: String, enum: ["original", "1:1", "4:3", "16:9"] },
    imageZoom: { type: Number, min: 1, max: 3 },
    imagePosition: { type: String },
    imageAlt: { type: String, default: "", maxlength: 300 },
    poll: { type: new mongoose.Schema({ options: { type: [String] }, days: { type: Number } }, { _id: false }), default: undefined },
    isAiText: { type: Boolean, default: false },
    isAiImage: { type: Boolean, default: false },
    publishAt: { type: Date, required: true },
    // scheduled: waiting; publishing: claimed by one run (a run that died is picked up again after a couple of minutes); failed: couldn't be
    // published (the reason is for its author, who can move it to another time or remove it)
    status: { type: String, enum: ["scheduled", "publishing", "failed"], default: "scheduled" },
    // the id the post will have, fixed when the run claims it, so a retry after a crash makes the same post and not a second one
    postId: { type: mongoose.Schema.Types.ObjectId, default: null },
    claimedAt: { type: Date, default: null },
    failure: { type: String, default: "" },
  },
  { timestamps: true }
);

scheduledPostSchema.index({ status: 1, publishAt: 1 });
scheduledPostSchema.index({ author: 1, publishAt: 1 });

export const ScheduledPost = mongoose.model("ScheduledPost", scheduledPostSchema);
