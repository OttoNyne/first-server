import { Router } from "express";
import mongoose from "mongoose";
import { MediaItem } from "../models/MediaItem.js";
import { ProcessStep } from "../models/ProcessStep.js";
import { User } from "../models/User.js";
import { requireAuth, attachUserIfPresent } from "../middleware/auth.js";
import { assertVisible } from "../utils/visibility.js";
import { checkComment } from "../utils/commentInput.js";
import { allowEdit } from "../utils/textInput.js";
import { releasePictures } from "../services/commentPictures.js";
import { createLimiter } from "../utils/rateLimit.js";

// Process: how a portfolio piece was made, as a short list of steps (words and/or a picture each) that its owner adds, changes, puts in
// order and takes away. Anyone who can see the piece can walk through them; nobody else can add to them. Mounted at /api/media.
export const processRouter = Router();

export const MAX_STEPS = 12;
export const MAX_STEP = 500;
const stepLimiter = createLimiter({ name: "process-step", limit: 60, windowMs: 60 * 60 * 1000 });
const missingPiece = (res) => res.status(404).json({ error: "Media item not found" });
const missingStep = (res) => res.status(404).json({ error: "Step not found" });

const toPublicStep = (s) => ({ id: s._id, content: s.content, imageUrl: s.imageUrl ?? null, position: s.position, createdAt: s.createdAt, editedAt: s.editedAt ?? null });
const inOrder = (pieceId) => ProcessStep.find({ piece: pieceId }).sort({ position: 1, _id: 1 });

/** The piece, if the viewer may see it (its owner's profile is visible to them); otherwise null: the same answer as a missing piece. */
async function visiblePiece(id, viewerId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const item = await MediaItem.findById(id);
  if (!item) return null;
  try {
    await assertVisible(await User.findById(item.owner), viewerId);
  } catch {
    return null;
  }
  return item;
}

// The steps, in order.
processRouter.get("/:id/process", attachUserIfPresent, async (req, res) => {
  const item = await visiblePiece(req.params.id, req.user?.id);
  if (!item) return missingPiece(res);
  res.json({ steps: (await inOrder(item._id)).map(toPublicStep) });
});

// Add a step to your own piece: `{ content?, imageUrl? }`, with words or a picture (one you uploaded) or both. Up to twelve.
processRouter.post("/:id/process", requireAuth, async (req, res) => {
  const item = mongoose.isValidObjectId(req.params.id) ? await MediaItem.findById(req.params.id) : null;
  if (!item || String(item.owner) !== req.user.id) return missingPiece(res);
  const checked = await checkComment(req.body, { userId: req.user.id, max: MAX_STEP, label: "A step" });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const count = await ProcessStep.countDocuments({ piece: item._id });
  if (count >= MAX_STEPS) return res.status(400).json({ error: `A piece can have up to ${MAX_STEPS} steps` });
  if (!(await stepLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're adding steps too fast — try again in a bit" });
  const last = await ProcessStep.findOne({ piece: item._id }).sort({ position: -1 }).select("position");
  const step = await ProcessStep.create({ piece: item._id, owner: req.user.id, content: checked.value.content, imageUrl: checked.value.imageUrl ?? null, position: last ? last.position + 1 : 0 });
  res.status(201).json({ step: toPublicStep(step) });
});

// Put the steps in a new order: `{ ids: [...] }` must name every step of the piece exactly once.
processRouter.put("/:id/process/order", requireAuth, async (req, res) => {
  const item = mongoose.isValidObjectId(req.params.id) ? await MediaItem.findById(req.params.id) : null;
  if (!item || String(item.owner) !== req.user.id) return missingPiece(res);
  const steps = await inOrder(item._id);
  const ids = req.body?.ids;
  const valid = Array.isArray(ids) && ids.every((id) => typeof id === "string") && ids.length === steps.length && new Set(ids).size === ids.length && ids.every((id) => steps.some((s) => String(s._id) === id));
  if (!valid) return res.status(400).json({ error: "List every step once to put them in order" });
  await ProcessStep.bulkWrite(ids.map((id, position) => ({ updateOne: { filter: { _id: id }, update: { $set: { position } } } })));
  res.json({ steps: (await inOrder(item._id)).map(toPublicStep) });
});

// Change a step's words, or take its picture off (the owner only). A picture can't be swapped: add a new step instead.
processRouter.patch("/process/:stepId", requireAuth, async (req, res) => {
  const step = mongoose.isValidObjectId(req.params.stepId) ? await ProcessStep.findById(req.params.stepId) : null;
  if (!step || String(step.owner) !== req.user.id) return missingStep(res);
  const checked = await checkComment(req.body, { userId: req.user.id, max: MAX_STEP, label: "A step", current: step });
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await allowEdit(req, res))) return;
  const picture = checked.value.imageUrl !== undefined ? step.imageUrl : null;
  if (checked.value.content !== undefined && checked.value.content !== step.content) {
    step.content = checked.value.content;
    step.editedAt = new Date();
  }
  if (checked.value.imageUrl === null) step.imageUrl = null;
  await step.save();
  if (checked.value.imageUrl === null && picture) await releasePictures([{ author: step.owner, imageUrl: picture }]);
  res.json({ step: toPublicStep(step) });
});

// Take a step away (the owner only), and its picture with it if nothing else shows it.
processRouter.delete("/process/:stepId", requireAuth, async (req, res) => {
  const step = mongoose.isValidObjectId(req.params.stepId) ? await ProcessStep.findById(req.params.stepId) : null;
  if (!step || String(step.owner) !== req.user.id) return missingStep(res);
  await step.deleteOne();
  await releasePictures([{ author: step.owner, imageUrl: step.imageUrl }]);
  res.status(204).end();
});
