import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// A request for feedback on one of the owner's portfolio pieces, with an optional question ("is the colour too loud?"). People who can see the
// piece answer it with a couple of notes that only the owner (and the one who wrote each) can read.
const critiqueSchema = new mongoose.Schema(
  {
    piece: { type: ObjectId, ref: "MediaItem", required: true },
    owner: { type: ObjectId, ref: "User", required: true },
    question: { type: String, default: "", maxlength: 300 },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

critiqueSchema.index({ status: 1, _id: -1 });
critiqueSchema.index({ owner: 1, _id: -1 });
critiqueSchema.index({ piece: 1, status: 1 });

export const Critique = mongoose.model("Critique", critiqueSchema);
