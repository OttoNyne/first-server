import { Router } from "express";
import { Mute } from "../models/Mute.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { MAX_MUTED_PEOPLE, readWords } from "../utils/mutes.js";

// Muting: a quiet way to stop seeing someone (or some words) in your feed, Explore and notifications. Private to you: nobody is told.
export const mutesRouter = Router();
mutesRouter.use(requireAuth);

const muteLimiter = createLimiter({ name: "mute", limit: 120, windowMs: 60 * 60 * 1000 });
const person = (user) => ({ id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null });

// Who you have muted, and the words.
mutesRouter.get("/", async (req, res) => {
  const rows = await Mute.find({ user: req.user.id }).sort({ _id: -1 }).limit(MAX_MUTED_PEOPLE).populate("muted");
  const me = await User.findById(req.user.id).select("mutedWords");
  res.json({ people: rows.filter((r) => r.muted).map((r) => person(r.muted)), words: me?.mutedWords ?? [] });
});

// Mute someone. Muting twice changes nothing.
mutesRouter.put("/people/:username", async (req, res) => {
  const target = await User.findOne({ username: String(req.params.username).toLowerCase() }).select("_id");
  if (!target) return res.status(404).json({ error: "User not found" });
  if (String(target._id) === req.user.id) return res.status(400).json({ error: "You can't mute yourself" });
  if (await Mute.exists({ user: req.user.id, muted: target._id })) return res.json({ muted: true });
  if ((await Mute.countDocuments({ user: req.user.id })) >= MAX_MUTED_PEOPLE) return res.status(400).json({ error: `You can mute up to ${MAX_MUTED_PEOPLE} people — unmute someone first` });
  if (!(await muteLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're muting too fast — try again in a bit" });
  try {
    await Mute.create({ user: req.user.id, muted: target._id });
  } catch (err) {
    if (err?.code !== 11000) throw err; // two taps at once
  }
  res.status(201).json({ muted: true });
});

// Unmute. Always 204, whether or not you had.
mutesRouter.delete("/people/:username", async (req, res) => {
  const target = await User.findOne({ username: String(req.params.username).toLowerCase() }).select("_id");
  if (target) await Mute.deleteOne({ user: req.user.id, muted: target._id });
  res.status(204).end();
});

// Replace the list of words and phrases you don't want to see: `{ words: ["spoilers", "#politics"] }`.
mutesRouter.put("/words", async (req, res) => {
  const checked = readWords(req.body?.words);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await muteLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're muting too fast — try again in a bit" });
  await User.updateOne({ _id: req.user.id }, { $set: { mutedWords: checked.value } });
  res.json({ words: checked.value });
});
