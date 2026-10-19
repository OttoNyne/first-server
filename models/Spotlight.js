import mongoose from "mongoose";

// One of the two artist spotlights on the main screen, chosen by an administrator (see routes/admin.routes.js). A slot is 1 or 2 and holds at
// most one person; `piece` is the picture the admin chose to show (null: the person's featured piece, else their latest picture), and `note` is
// the line the admin wrote about them. Whether the person can be shown is decided when it is read (see services/spotlights.js).
const spotlightSchema = new mongoose.Schema(
  {
    slot: { type: Number, enum: [1, 2], required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    piece: { type: mongoose.Schema.Types.ObjectId, ref: "MediaItem", default: null },
    note: { type: String, default: "", maxlength: 140 },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
spotlightSchema.index({ user: 1 });

export const Spotlight = mongoose.model("Spotlight", spotlightSchema);
