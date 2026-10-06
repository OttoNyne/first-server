import mongoose from "mongoose";
import { REACTION_KEYS } from "../utils/reactionKeys.js";

// One emoji reaction from one person to one portfolio piece or one post (a person has at most one on each, which they can change or take
// away). The emoji is stored as one of a fixed set of names (see utils/reactions.js), never as free text.
const reactionSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: ["media", "post"], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    emoji: { type: String, enum: REACTION_KEYS, required: true },
  },
  { timestamps: true }
);

reactionSchema.index({ targetType: 1, target: 1, user: 1 }, { unique: true });
reactionSchema.index({ user: 1 });

export const Reaction = mongoose.model("Reaction", reactionSchema);
