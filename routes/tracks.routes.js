import { Router } from "express";
import { Track } from "../models/Track.js";
import { requireAuth } from "../middleware/auth.js";
import { extractYouTubeId } from "../utils/youtube.js";
import { toPublicTrack } from "../utils/serialize.js";

export const tracksRouter = Router();
tracksRouter.use(requireAuth);

tracksRouter.post("/", async (req, res) => {
  const count = await Track.countDocuments({ owner: req.user.id });
  if (count >= 5) return res.status(400).json({ error: "Maximum of 5 tracks reached" });

  let url = req.body.url;
  if (req.body.sourceType === "youtube") {
    const id = extractYouTubeId(url);
    if (!id) return res.status(400).json({ error: "Invalid YouTube URL" });
    url = id;
  }

  const track = await Track.create({
    owner: req.user.id,
    title: req.body.title,
    sourceType: req.body.sourceType,
    url,
    position: count,
  });
  res.status(201).json({ track: toPublicTrack(track) });
});

tracksRouter.delete("/:id", async (req, res) => {
  const track = await Track.findById(req.params.id);
  if (!track) return res.status(404).json({ error: "Track not found" });
  if (String(track.owner) !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  await track.deleteOne();

  const remaining = await Track.find({ owner: req.user.id }).sort("position");
  await Promise.all(remaining.map((t, index) => Track.updateOne({ _id: t._id }, { position: index })));

  res.status(204).end();
});
