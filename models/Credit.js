import mongoose from "mongoose";

// A credit: the owner of a portfolio piece says another person worked on it, and in what role ("illustrator", "producer").
// It counts only once that person accepts, so nobody can put their name on someone's work, or someone else's name on theirs, by themselves.
const creditSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", required: true },
    // the owner of the piece (kept here so the credits someone has been given can be found without looking at every piece)
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    person: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, required: true, maxlength: 40 },
    status: { type: String, enum: ["pending", "accepted"], default: "pending" },
  },
  { timestamps: true }
);

// one credit per person on a piece; and the two ways it is looked up
creditSchema.index({ item: 1, person: 1 }, { unique: true });
creditSchema.index({ person: 1, status: 1 });

export const Credit = mongoose.model("Credit", creditSchema);
