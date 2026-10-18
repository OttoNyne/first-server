import mongoose from "mongoose";

// An exquisite-corpse chain: a drawing made in parts by different people, each seeing only a thin strip of the part before. The parts
// themselves are in ChainSection (so listing chains never loads a picture). `count` is how many parts are drawn; the chain is complete when it
// reaches CHAIN_PARTS (see routes/chains.routes.js). Whoever is about to draw the next part holds a claim on the chain for a while, so two
// people are never drawing the same part.
const chainSchema = new mongoose.Schema(
  {
    creator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    prompt: { type: String, default: "", maxlength: 100 },
    count: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["open", "complete"], default: "open" },
    // everyone who has drawn a part, in order; nobody draws twice on one chain
    contributors: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },
    claimUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    claimUntil: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

chainSchema.index({ status: 1, updatedAt: 1 });
chainSchema.index({ status: 1, completedAt: -1 });
chainSchema.index({ contributors: 1, updatedAt: -1 });
chainSchema.index({ creator: 1, status: 1 });

export const Chain = mongoose.model("Chain", chainSchema);
