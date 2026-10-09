import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// One person's feedback on a request: what is working, and what they would change (either can be empty, not both). One per person per request.
// Only the owner of the piece and the person who wrote it can read it.
const critiqueNoteSchema = new mongoose.Schema(
  {
    critique: { type: ObjectId, ref: "Critique", required: true },
    author: { type: ObjectId, ref: "User", required: true },
    working: { type: String, default: "", maxlength: 500 },
    change: { type: String, default: "", maxlength: 500 },
    // the owner said thank you (the writer is told once)
    thanked: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

critiqueNoteSchema.index({ critique: 1, author: 1 }, { unique: true });
critiqueNoteSchema.index({ author: 1, _id: -1 });

export const CritiqueNote = mongoose.model("CritiqueNote", critiqueNoteSchema);
