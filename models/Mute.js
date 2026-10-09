import mongoose from "mongoose";

// Someone a person has muted: their posts and pieces stop showing in the muter's feed and Explore, and they stop appearing in the muter's
// notifications. Nobody is told, and nothing changes for the person muted (unlike a block).
const muteSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    muted: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

muteSchema.index({ user: 1, muted: 1 }, { unique: true });
muteSchema.index({ muted: 1 });

export const Mute = mongoose.model("Mute", muteSchema);
