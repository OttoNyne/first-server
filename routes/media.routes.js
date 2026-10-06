import { Router } from "express";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import { MediaItem } from "../models/MediaItem.js";
import { MediaReaction } from "../models/MediaReaction.js";
import { MediaComment } from "../models/MediaComment.js";
import { Album } from "../models/Album.js";
import { User } from "../models/User.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { recordStoredAsset, deleteStoredAssetIfUnused } from "../services/storedAssets.js";
import { toPublicMediaItem } from "../utils/serialize.js";
import { releasePictures } from "../services/commentPictures.js";
import { assertVisible, getProfileForViewer } from "../utils/visibility.js";
import { createLimiter } from "../utils/rateLimit.js";
import { MAX_COMMENT_PICTURE_BYTES, commentPictureLimiter } from "../utils/commentPictures.js";
import { MAX_VIDEO_SECONDS, parseStartSeconds, parseVideoLink } from "../utils/videoLinks.js";
import { checkCaption } from "../utils/mediaCaption.js";

export const mediaRouter = Router();

// One person's portfolio holds at most this many pieces, so it can always be listed in one go.
export const MAX_PORTFOLIO = 200;

// Cloudinary reports the duration of a video it has just ingested; allow a
// little rounding slack over the 30-second limit.
const DURATION_SLACK_SECONDS = 0.75;

mediaRouter.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded, or that file type isn't supported here" });
  const purpose = req.query.purpose || "portfolio";
  const url = req.file.path;
  const isVideo = req.file.mimetype.startsWith("video/");
  const isPortfolio = purpose === "portfolio" || !["avatars", "wallpapers", "tracks", "comments"].includes(purpose);

  // A picture for a comment is smaller than a portfolio piece and limited per person; the file is already stored, so take it out again.
  if (purpose === "comments") {
    const tooBig = Number(req.file.size) > MAX_COMMENT_PICTURE_BYTES;
    const tooMany = !tooBig && !(await commentPictureLimiter.allow(req.user.id));
    if (tooBig || tooMany) {
      await cloudinary.uploader.destroy(req.file.filename, { resource_type: "image", invalidate: true }).catch(() => {});
      if (tooMany) res.set("Retry-After", String(commentPictureLimiter.windowSeconds));
      return res.status(tooBig ? 413 : 429).json({ error: tooBig ? "Pictures in comments can be up to 5 MB." : "You've added a lot of pictures to comments — try again in a while." });
    }
  }

  // A full portfolio can't take another piece; the file was already stored, so take it out again.
  if (isPortfolio && (await MediaItem.countDocuments({ owner: req.user.id })) >= MAX_PORTFOLIO) {
    await cloudinary.uploader.destroy(req.file.filename, { resource_type: isVideo ? "video" : "image", invalidate: true }).catch(() => {});
    return res.status(400).json({ error: `Your portfolio is full (${MAX_PORTFOLIO} pieces) — remove one to add another` });
  }

  // A portfolio piece can arrive with a caption (a form field next to the file). One that can't be kept is refused, and the file taken out again.
  const caption = isPortfolio ? checkCaption(req.body?.caption) : { value: null };
  if (caption.error) {
    await cloudinary.uploader.destroy(req.file.filename, { resource_type: isVideo ? "video" : "image", invalidate: true }).catch(() => {});
    return res.status(400).json({ error: caption.error });
  }

  // Portfolio videos are limited to 30 seconds. The duration is only known
  // once the storage provider has the file, so check it now and remove the
  // file again if it's too long.
  if (isPortfolio && isVideo) {
    const duration = Number(req.file.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_SECONDS + DURATION_SLACK_SECONDS) {
      try {
        await cloudinary.uploader.destroy(req.file.filename, { resource_type: "video", invalidate: true });
      } catch (err) {
        console.error("Couldn't remove rejected video:", err?.message ?? err);
      }
      return res.status(400).json({
        error: Number.isFinite(duration) && duration > 0
          ? `Videos can be up to ${MAX_VIDEO_SECONDS} seconds — this one is ${Math.round(duration)} seconds`
          : "Couldn't read that video's length — try an .mp4 file",
      });
    }
  }

  // Audio is stored by Cloudinary as a "video" resource; needed later to delete it.
  await recordStoredAsset({
    ownerId: req.user.id,
    url,
    publicId: req.file.filename,
    resourceType: req.file.mimetype.startsWith("image") ? "image" : "video",
    kind: "upload",
  });

  if (isPortfolio) {
    const mediaType = isVideo ? "video" : req.file.mimetype.startsWith("audio") ? "audio" : "image";
    const item = await MediaItem.create({
      owner: req.user.id,
      url,
      type: mediaType,
      caption: caption.value,
      ...(isVideo ? { durationSeconds: Number(req.file.duration) } : {}),
    });
    return res.status(201).json({ url, mediaItem: toPublicMediaItem(item) });
  }

  res.status(201).json({ url });
});

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// Add a portfolio item by URL: an image (search result / AI image) or a video
// link. Only https links (or an inline image from the mock AI provider) are
// accepted, and video links must be YouTube or a direct video file.
mediaRouter.post("/", requireAuth, async (req, res) => {
  const { url, type = "image", isAiImage } = req.body ?? {};
  const caption = checkCaption(req.body?.caption);
  if (caption.error) return badRequest(res, caption.error);

  if ((await MediaItem.countDocuments({ owner: req.user.id })) >= MAX_PORTFOLIO) {
    return badRequest(res, `Your portfolio is full (${MAX_PORTFOLIO} pieces) — remove one to add another`);
  }

  let item;
  try {
    if (type === "video" || type === "embed") {
      const parsed = parseVideoLink(url);
      item = { type: parsed.type, url: parsed.url, startSeconds: parseStartSeconds(req.body.startSeconds) };
    } else if (type === "image") {
      const ok = typeof url === "string" && url.length <= 4_000_000 && (/^https:\/\//i.test(url) || /^data:image\//i.test(url));
      if (!ok) return badRequest(res, "Image links must start with https://");
      item = { type: "image", url };
    } else {
      return badRequest(res, "type must be image or video");
    }
  } catch (err) {
    return badRequest(res, err.message);
  }

  const created = await MediaItem.create({
    owner: req.user.id,
    ...item,
    caption: caption.value,
    isAiImage: item.type === "image" ? Boolean(isAiImage) : false,
  });
  res.status(201).json({ mediaItem: toPublicMediaItem(created) });
});

// Like/dislike counts for a set of items, plus the viewer's own reaction.
async function reactionSummary(itemIds, viewerId) {
  const counts = await MediaReaction.aggregate([
    { $match: { item: { $in: itemIds } } },
    { $group: { _id: { item: "$item", value: "$value" }, n: { $sum: 1 } } },
  ]);
  const byItem = new Map();
  for (const c of counts) {
    const key = String(c._id.item);
    const entry = byItem.get(key) ?? { likes: 0, dislikes: 0, myReaction: 0 };
    if (c._id.value === 1) entry.likes = c.n;
    else entry.dislikes = c.n;
    byItem.set(key, entry);
  }
  if (viewerId) {
    const mine = await MediaReaction.find({ item: { $in: itemIds }, user: viewerId });
    for (const r of mine) {
      const key = String(r.item);
      const entry = byItem.get(key) ?? { likes: 0, dislikes: 0, myReaction: 0 };
      entry.myReaction = r.value;
      byItem.set(key, entry);
    }
  }
  return byItem;
}

mediaRouter.get("/user/:username", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const items = await MediaItem.find({ owner: user._id }).sort("-createdAt");
    const ids = items.map((i) => i._id);
    const summary = await reactionSummary(ids, req.user?.id);
    const counts = new Map((await MediaComment.aggregate([{ $match: { item: { $in: ids } } }, { $group: { _id: "$item", n: { $sum: 1 } } }])).map((c) => [String(c._id), c.n]));
    res.json({
      media: items.map((item) => toPublicMediaItem(item, { ...summary.get(String(item._id)), commentCount: counts.get(String(item._id)) ?? 0 })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Like (1), dislike (-1) or clear (0) your reaction. You can only react to
// items you're allowed to see (private profiles, blocks).
const reactionLimit = createLimiter({ name: "media-reaction", limit: 300, windowMs: 60 * 60 * 1000 });

mediaRouter.put("/:id/reaction", requireAuth, async (req, res) => {
  const value = req.body?.value;
  if (![1, -1, 0].includes(value)) return badRequest(res, "value must be 1 (like), -1 (dislike) or 0 (clear)");

  const item = await MediaItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "Media item not found" });
  try {
    const owner = await User.findById(item.owner);
    await assertVisible(owner, req.user.id);
  } catch {
    // Same answer as a missing item, so a private profile's items aren't revealed.
    return res.status(404).json({ error: "Media item not found" });
  }
  if (!(await reactionLimit.allow(req.user.id))) {
    return res.status(429).json({ error: "You're reacting too fast — try again in a bit" });
  }

  if (value === 0) {
    await MediaReaction.deleteOne({ item: item._id, user: req.user.id });
  } else {
    await MediaReaction.findOneAndUpdate(
      { item: item._id, user: req.user.id },
      { item: item._id, user: req.user.id, value },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
  const summary = (await reactionSummary([item._id], req.user.id)).get(String(item._id));
  res.json({ likes: summary?.likes ?? 0, dislikes: summary?.dislikes ?? 0, myReaction: summary?.myReaction ?? 0 });
});

// Change a piece's caption (`{caption: "text"}`, or `{caption: null}` to take it off) and/or put it in one of your albums or take it out
// (`{album: id}` or `{album: null}`). Only the owner, and only into the owner's own album; nothing else about a piece can be changed.
mediaRouter.patch("/:id", requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Media item not found" });
  const item = await MediaItem.findOne({ _id: req.params.id, owner: req.user.id });
  if (!item) return res.status(404).json({ error: "Media item not found" });
  const album = req.body?.album;
  const wantsCaption = req.body !== undefined && req.body !== null && Object.hasOwn(req.body, "caption");
  if (album === undefined && !wantsCaption) return badRequest(res, "Say what to change: a caption, or an album (null for none)");
  if (wantsCaption) {
    const caption = checkCaption(req.body.caption);
    if (caption.error) return badRequest(res, caption.error);
    item.caption = caption.value;
  }
  if (album === null) {
    item.album = null;
  } else if (album !== undefined) {
    if (typeof album !== "string" || !mongoose.isValidObjectId(album) || !(await Album.exists({ _id: album, owner: req.user.id }))) {
      return res.status(404).json({ error: "Album not found" });
    }
    item.album = album;
  }
  await item.save();
  res.json({ item: toPublicMediaItem(item) });
});

mediaRouter.delete("/:id", requireAuth, async (req, res) => {
  const item = await MediaItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "Media item not found" });
  if (String(item.owner) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  await item.deleteOne();
  await MediaReaction.deleteMany({ item: item._id });
  const withPictures = await MediaComment.find({ item: item._id, imageUrl: { $ne: null } });
  await MediaComment.deleteMany({ item: item._id });
  await releasePictures(withPictures);
  await deleteStoredAssetIfUnused({ ownerId: item.owner, url: item.url });
  res.status(204).end();
});
