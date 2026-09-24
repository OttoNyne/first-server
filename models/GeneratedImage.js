import mongoose from "mongoose";

// Ledger of images the AI provider generated and stored on Cloudinary, keyed
// by who asked for them. It exists so the app can safely delete a generated
// image when nothing uses it any more: only assets recorded here (never a URL
// a client merely claims is AI-generated) are ever deleted.
const generatedImageSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    url: { type: String, required: true, index: true },
    publicId: { type: String, required: true },
  },
  { timestamps: true }
);

export const GeneratedImage = mongoose.model("GeneratedImage", generatedImageSchema);
