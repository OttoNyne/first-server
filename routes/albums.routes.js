import { Router } from "express";
import mongoose from "mongoose";
import { Album } from "../models/Album.js";
import { MediaItem } from "../models/MediaItem.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { getProfileForViewer } from "../utils/visibility.js";
import { cleanLine } from "../utils/profileFields.js";
import { escapeRegex } from "../utils/regex.js";

// Portfolio albums: named groups of a person's pieces. Who can see an album is who can see the profile, the same rule as the portfolio.
export const albumsRouter = Router();

export const MAX_ALBUM_TITLE = 60;
export const MAX_ALBUMS = 12;
const validId = (id) => mongoose.isValidObjectId(id);

function checkTitle(value) {
  if (typeof value !== "string" || !cleanLine(value)) return { error: "Give your album a name" };
  const title = cleanLine(value);
  if (title.length > MAX_ALBUM_TITLE) return { error: `Album names can be up to ${MAX_ALBUM_TITLE} characters` };
  return { title };
}

const sameName = (ownerId, title, exceptId) => Album.findOne({ owner: ownerId, title: new RegExp(`^${escapeRegex(title)}$`, "i"), ...(exceptId ? { _id: { $ne: exceptId } } : {}) });

async function serialize(albums, ownerId) {
  const counts = await MediaItem.aggregate([{ $match: { owner: new mongoose.Types.ObjectId(String(ownerId)), album: { $in: albums.map((a) => a._id) } } }, { $group: { _id: "$album", count: { $sum: 1 } } }]);
  const byAlbum = new Map(counts.map((c) => [String(c._id), c.count]));
  return albums.map((a) => ({ id: a._id, title: a.title, count: byAlbum.get(String(a._id)) ?? 0 }));
}

// A person's albums, oldest first, with how many pieces each holds. Same gate as the rest of their profile.
albumsRouter.get("/user/:username", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const albums = await Album.find({ owner: user._id }).sort({ createdAt: 1, _id: 1 });
    res.json({ albums: await serialize(albums, user._id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

albumsRouter.post("/", requireAuth, async (req, res) => {
  const checked = checkTitle(req.body?.title);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if ((await Album.countDocuments({ owner: req.user.id })) >= MAX_ALBUMS) return res.status(400).json({ error: `You can have up to ${MAX_ALBUMS} albums` });
  if (await sameName(req.user.id, checked.title)) return res.status(409).json({ error: "You already have an album with that name" });
  const album = await Album.create({ owner: req.user.id, title: checked.title });
  res.status(201).json({ album: { id: album._id, title: album.title, count: 0 } });
});

// Only the owner can rename or delete an album; anyone else gets the same 404 as for one that isn't there.
albumsRouter.patch("/:id", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Album not found" });
  const album = await Album.findOne({ _id: req.params.id, owner: req.user.id });
  if (!album) return res.status(404).json({ error: "Album not found" });
  const checked = checkTitle(req.body?.title);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (await sameName(req.user.id, checked.title, album._id)) return res.status(409).json({ error: "You already have an album with that name" });
  album.title = checked.title;
  await album.save();
  res.json({ album: (await serialize([album], req.user.id))[0] });
});

// Deleting an album keeps its pieces: they go back to being in the portfolio without an album.
albumsRouter.delete("/:id", requireAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Album not found" });
  const album = await Album.findOneAndDelete({ _id: req.params.id, owner: req.user.id });
  if (!album) return res.status(404).json({ error: "Album not found" });
  await MediaItem.updateMany({ owner: req.user.id, album: album._id }, { $set: { album: null } });
  res.status(204).end();
});
