import mongoose from "mongoose";

const trackSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    sourceType: { type: String, enum: ["upload", "youtube"], required: true },
    url: { type: String, required: true },
    position: { type: Number, required: true },
  },
  { timestamps: true }
);

export const Track = mongoose.model("Track", trackSchema);
