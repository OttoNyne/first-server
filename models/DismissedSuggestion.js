import mongoose from "mongoose";

// Someone a person told us they don't want to be suggested to them again ("Not interested" under People you may know).
const dismissedSuggestionSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    target: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
dismissedSuggestionSchema.index({ owner: 1, target: 1 }, { unique: true });

export const DismissedSuggestion = mongoose.model("DismissedSuggestion", dismissedSuggestionSchema);
