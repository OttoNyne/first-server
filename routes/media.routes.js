import { Router } from "express";
import { MediaItem } from "../models/MediaItem.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { toPublicMediaItem } from "../utils/serialize.js";

export const mediaRouter = Router();

mediaRouter.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const purpose = req.query.purpose || "portfolio";
  const folder = ["avatars", "wallpapers", "portfolio", "tracks"].includes(purpose)
    ? purpose
    : "portfolio";
  const url = `/uploads/${folder}/${req.file.filename}`;

  if (purpose === "portfolio" || !["avatars", "wallpapers", "tracks"].includes(purpose)) {
    const mediaType = req.file.mimetype.startsWith("video")
      ? "video"
      : req.file.mimetype.startsWith("audio")
        ? "audio"
        : "image";
    const item = await MediaItem.create({ owner: req.user.id, url, type: mediaType });
    return res.status(201).json({ url, mediaItem: toPublicMediaItem(item) });
  }

  res.status(201).json({ url });
});

mediaRouter.post("/", requireAuth, async (req, res) => {
  const item = await MediaItem.create({
    owner: req.user.id,
    url: req.body.url,
    type: req.body.type,
    caption: req.body.caption,
    isAiImage: req.body.isAiImage || false,
  });
  res.status(201).json({ mediaItem: toPublicMediaItem(item) });
});

mediaRouter.get("/user/:username", async (req, res) => {
  const user = await User.findOne({ username: req.params.username });
  if (!user) return res.status(404).json({ error: "User not found" });
  const items = await MediaItem.find({ owner: user._id }).sort("-createdAt");
  res.json({ media: items.map(toPublicMediaItem) });
});

mediaRouter.delete("/:id", requireAuth, async (req, res) => {
  const item = await MediaItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "Media item not found" });
  if (String(item.owner) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  await item.deleteOne();
  res.status(204).end();
});
