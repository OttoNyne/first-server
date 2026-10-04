import mongoose from "mongoose";

// A longer piece of writing on someone's profile: a journal or blog entry, kept apart from the short feed posts.
const blogEntrySchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 120 },
    // plain text; blank lines separate paragraphs
    body: { type: String, required: true, maxlength: 10000 },
  },
  { timestamps: true }
);

blogEntrySchema.index({ author: 1, createdAt: -1 });

export const BlogEntry = mongoose.model("BlogEntry", blogEntrySchema);
