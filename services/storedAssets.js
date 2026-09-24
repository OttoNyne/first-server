import { v2 as cloudinary } from "cloudinary";
import { StoredAsset } from "../models/StoredAsset.js";
import { Post } from "../models/Post.js";
import { User } from "../models/User.js";
import { MediaItem } from "../models/MediaItem.js";
import { Track } from "../models/Track.js";
import { Group } from "../models/Group.js";

export async function recordStoredAsset({ ownerId, url, publicId, resourceType = "image", kind = "ai" }) {
  if (!url || !publicId) return;
  await StoredAsset.create({ owner: ownerId, url, publicId, resourceType, kind });
}

async function isStillReferenced(url) {
  const [post, user, media, track, group] = await Promise.all([
    Post.exists({ imageUrl: url }),
    User.exists({ $or: [{ avatarUrl: url }, { wallpaperUrl: url }] }),
    MediaItem.exists({ url }),
    Track.exists({ url }),
    Group.exists({ bannerUrl: url }),
  ]);
  return Boolean(post || user || media || track || group);
}

function destroyAsset(asset) {
  // invalidate: purge Cloudinary's CDN cache too, or the file keeps being served.
  return cloudinary.uploader.destroy(asset.publicId, { resource_type: asset.resourceType, invalidate: true });
}

// Call after the last thing that used `url` was removed or replaced. Deletes
// the file from Cloudinary only if it's recorded as stored for `ownerId` and
// nothing else — another post, an avatar/wallpaper, a portfolio item, a
// track, a group banner — still points at it. Never throws: a failed cleanup
// must not fail the user's own action, it just leaves an orphan behind.
export async function deleteStoredAssetIfUnused({ ownerId, url }) {
  if (!url) return false;
  try {
    const asset = await StoredAsset.findOne({ url, owner: ownerId });
    if (!asset) return false;
    if (await isStillReferenced(url)) return false;
    await destroyAsset(asset);
    await StoredAsset.deleteMany({ url, owner: ownerId });
    return true;
  } catch (err) {
    console.error("Stored asset cleanup failed:", err);
    return false;
  }
}

// Account deletion: remove every file recorded for this user, regardless of
// remaining references (the references are being deleted with the account).
// Returns how many were removed; individual failures are logged and skipped.
export async function deleteAllStoredAssets(ownerId) {
  const assets = await StoredAsset.find({ owner: ownerId });
  let removed = 0;
  for (const asset of assets) {
    try {
      await destroyAsset(asset);
      removed += 1;
    } catch (err) {
      console.error("Couldn't delete stored asset", asset.publicId, err);
    }
  }
  await StoredAsset.deleteMany({ owner: ownerId });
  return removed;
}
