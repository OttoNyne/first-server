import { Router } from "express";
import mongoose from "mongoose";
import { Track } from "../models/Track.js";
import { TrackPlay } from "../models/TrackPlay.js";
import { StoredAsset } from "../models/StoredAsset.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { extractYouTubeId } from "../utils/youtube.js";
import { toPublicTrack } from "../utils/serialize.js";
import { assertVisible } from "../utils/visibility.js";
import { allowEdit } from "../utils/textInput.js";
import { MAX_TRACKS, MAX_UPLOADS, checkTrackText } from "../utils/trackInput.js";
import { createLimiter } from "../utils/rateLimit.js";
import { deleteStoredAssetIfUnused } from "../services/storedAssets.js";

export const tracksRouter = Router();
tracksRouter.use(requireAuth);

const playLimiter = createLimiter({ name: "track-play", limit: 300, windowMs: 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);

tracksRouter.post("/", async (req, res) => {
  const { sourceType } = req.body ?? {};
  if (sourceType !== "upload" && sourceType !== "youtube") return res.status(400).json({ error: "sourceType must be upload or youtube" });
  const text = checkTrackText(req.body);
  if (text.error) return res.status(400).json({ error: text.error });

  const count = await Track.countDocuments({ owner: req.user.id });
  if (count >= MAX_TRACKS) return res.status(400).json({ error: `Maximum of ${MAX_TRACKS} tracks reached` });

  let url = req.body.url;
  if (typeof url !== "string" || !url) return res.status(400).json({ error: "url is required" });
  if (sourceType === "youtube") {
    const id = extractYouTubeId(url);
    if (!id) return res.status(400).json({ error: "Invalid YouTube URL" });
    url = id;
  } else {
    // A song we store is a file the person uploaded here: the address has to be one we recorded for them, not just any address.
    const stored = await StoredAsset.exists({ owner: req.user.id, url, kind: "upload", resourceType: "video" });
    if (!stored) return res.status(400).json({ error: "Upload the song first, then add it" });
    if ((await Track.countDocuments({ owner: req.user.id, sourceType: "upload" })) >= MAX_UPLOADS) {
      return res.status(400).json({ error: `You can have up to ${MAX_UPLOADS} uploaded songs — YouTube links don't count towards that` });
    }
  }

  const track = await Track.create({ owner: req.user.id, ...text.value, sourceType, url, position: count });
  res.status(201).json({ track: toPublicTrack(track) });
});

// Put the owner's tracks in a new order. The list must be exactly their tracks, each once — nothing added, dropped or repeated.
tracksRouter.put("/order", async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return res.status(400).json({ error: "ids must be a list of track ids" });
  }
  const mine = await Track.find({ owner: req.user.id }).sort("position");
  const mineIds = new Set(mine.map((t) => String(t._id)));
  if (ids.length !== mine.length || new Set(ids).size !== ids.length || !ids.every((id) => mineIds.has(id))) {
    return res.status(400).json({ error: "Send every one of your tracks exactly once" });
  }
  await Track.bulkWrite(ids.map((id, position) => ({ updateOne: { filter: { _id: id, owner: req.user.id }, update: { $set: { position } } } })));
  const tracks = await Track.find({ owner: req.user.id }).sort("position");
  res.json({ tracks: tracks.map(toPublicTrack) });
});

// Change your own track's title or artist, or make it (or stop it being) the profile song. Only one track is the profile song.
tracksRouter.patch("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Track not found" });
  const track = await Track.findOne({ _id: req.params.id, owner: req.user.id });
  if (!track) return res.status(404).json({ error: "Track not found" });

  const wantsText = req.body?.title !== undefined || req.body?.artist !== undefined;
  const wantsSong = req.body?.profileSong !== undefined;
  if (!wantsText && !wantsSong) return res.status(400).json({ error: "Nothing to change" });
  if (wantsSong && typeof req.body.profileSong !== "boolean") return res.status(400).json({ error: "profileSong must be true or false" });
  let text = { value: {} };
  if (wantsText) {
    text = checkTrackText(req.body, { partial: true });
    if (text.error) return res.status(400).json({ error: text.error });
    if (!(await allowEdit(req, res))) return;
  }

  if (wantsSong && req.body.profileSong !== track.profileSong) {
    if (req.body.profileSong) await Track.updateMany({ owner: req.user.id, profileSong: true, _id: { $ne: track._id } }, { $set: { profileSong: false } });
    track.profileSong = req.body.profileSong;
  }
  for (const [key, value] of Object.entries(text.value)) track[key] = value;
  await track.save();
  res.json({ track: toPublicTrack(track) });
});

// A listener played a track. It counts once a day per listener per track, never for the owner's own plays, and only for tracks the
// listener may see (private and blocked profiles are the same 404 as a track that doesn't exist). Nobody is told who listened.
tracksRouter.post("/:id/play", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Track not found" });
  const track = await Track.findById(req.params.id);
  if (!track) return res.status(404).json({ error: "Track not found" });
  try {
    await assertVisible(await User.findById(track.owner), req.user.id);
  } catch {
    return res.status(404).json({ error: "Track not found" });
  }
  if (String(track.owner) === req.user.id) return res.json({ counted: false, plays: track.plays });
  if (!(await playLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(playLimiter.windowSeconds));
    return res.status(429).json({ error: "You're playing a lot of songs — try again in a bit." });
  }
  let upserted = 0;
  try {
    upserted = (await TrackPlay.updateOne({ track: track._id, listener: req.user.id }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true })).upsertedCount;
  } catch (err) {
    // two plays at the same moment: the other one made the record, so this one is a repeat
    if (err?.code !== 11000) throw err;
  }
  let plays = track.plays;
  if (upserted) plays = (await Track.findByIdAndUpdate(track._id, { $inc: { plays: 1 } }, { new: true }))?.plays ?? plays + 1;
  res.json({ counted: Boolean(upserted), plays });
});

tracksRouter.delete("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Track not found" });
  const track = await Track.findById(req.params.id);
  if (!track) return res.status(404).json({ error: "Track not found" });
  if (String(track.owner) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  await track.deleteOne();
  await TrackPlay.deleteMany({ track: track._id });
  if (track.sourceType === "upload") await deleteStoredAssetIfUnused({ ownerId: track.owner, url: track.url });

  const remaining = await Track.find({ owner: req.user.id }).sort("position");
  await Promise.all(remaining.map((t, index) => Track.updateOne({ _id: t._id }, { position: index })));

  res.status(204).end();
});
