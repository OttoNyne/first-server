import { v2 as cloudinary } from "cloudinary";
import { GeneratedImage } from "../models/GeneratedImage.js";
import { Post } from "../models/Post.js";
import { User } from "../models/User.js";
import { MediaItem } from "../models/MediaItem.js";

export async function recordGeneratedImage({ ownerId, url, publicId }) {
  if (!url || !publicId) return;
  await GeneratedImage.create({ owner: ownerId, url, publicId });
}

async function isStillReferenced(url) {
  const [post, user, media] = await Promise.all([
    Post.exists({ imageUrl: url }),
    User.exists({ $or: [{ avatarUrl: url }, { wallpaperUrl: url }] }),
    MediaItem.exists({ url }),
  ]);
  return Boolean(post || user || media);
}

// Call after the last thing that used `url` was removed. Deletes the image
// from Cloudinary only if it was generated for `ownerId` (per the ledger) and
// nothing else — another post, a profile picture/wallpaper, a portfolio item —
// still points at it. Never throws: a failed cleanup must not fail the
// user's own action, it just leaves an orphan behind.
export async function deleteGeneratedImageIfUnused({ ownerId, url }) {
  if (!url) return false;
  try {
    const record = await GeneratedImage.findOne({ url, owner: ownerId });
    if (!record) return false;
    if (await isStillReferenced(url)) return false;
    await cloudinary.uploader.destroy(record.publicId, { invalidate: true });
    await GeneratedImage.deleteMany({ url, owner: ownerId });
    return true;
  } catch (err) {
    console.error("Generated image cleanup failed:", err);
    return false;
  }
}
