import mongoose from "mongoose";

// One step in how a portfolio piece was made (a sketch, a draft, a revision): a few words and/or a picture, in the order its owner puts
// them. Visitors walk through the steps and end on the finished piece.
const processStepSchema = new mongoose.Schema(
  {
    piece: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, default: "", maxlength: 500 },
    // a picture the owner uploaded for it (kept in the stored-files ledger like a comment's picture)
    imageUrl: { type: String, default: null },
    position: { type: Number, default: 0 },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

processStepSchema.index({ piece: 1, position: 1, _id: 1 });
processStepSchema.index({ owner: 1 });

export const ProcessStep = mongoose.model("ProcessStep", processStepSchema);
