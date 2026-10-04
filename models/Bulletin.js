import mongoose from "mongoose";

// A short announcement an author posts to all of their friends at once. Only accepted friends (and the author) can read it,
// and it takes itself down after a while (see routes/bulletins.routes.js).
const bulletinSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 80 },
    body: { type: String, required: true, maxlength: 500 },
    expireAt: { type: Date, required: true, expires: 0 },
    // When the author last changed what they wrote (null if never).
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

bulletinSchema.index({ author: 1, createdAt: -1 });

export const Bulletin = mongoose.model("Bulletin", bulletinSchema);
