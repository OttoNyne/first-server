import mongoose from "mongoose";

// Ledger of files the server itself stored on Cloudinary (AI-generated images
// and user uploads) and who they belong to. It exists so the app can delete
// an asset safely — when its last reference goes away, or when an account is
// deleted. Only assets recorded here are ever deleted; a URL a client merely
// claims to own (posts, portfolio items and group banners accept arbitrary
// URLs) is never enough.
const storedAssetSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    url: { type: String, required: true, index: true },
    publicId: { type: String, required: true },
    // Cloudinary needs the resource type to delete: audio is stored as "video".
    resourceType: { type: String, enum: ["image", "video", "raw"], default: "image" },
    kind: { type: String, enum: ["ai", "upload"], default: "ai" },
  },
  { timestamps: true }
);

export const StoredAsset = mongoose.model("StoredAsset", storedAssetSchema);
