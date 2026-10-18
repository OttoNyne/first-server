import mongoose from "mongoose";

// One part of a chain (see models/Chain.js): the drawing as a PNG, and the thin strip along its bottom edge that the next person is shown
// instead of it. The pictures are kept here, not on a storage service, and are never loaded unless asked for (`select: false`).
const chainSectionSchema = new mongoose.Schema(
  {
    chain: { type: mongoose.Schema.Types.ObjectId, ref: "Chain", required: true },
    index: { type: Number, required: true, min: 0 },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    png: { type: Buffer, required: true, select: false },
    edge: { type: Buffer, default: null, select: false },
  },
  { timestamps: true }
);

chainSectionSchema.index({ chain: 1, index: 1 }, { unique: true });
chainSectionSchema.index({ author: 1 });

export const ChainSection = mongoose.model("ChainSection", chainSectionSchema);
