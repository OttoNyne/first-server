import { Router } from "express";
import multer from "multer";
import { sniffImageType } from "../utils/imageSniff.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { recordStoredAsset, deleteStoredAssetIfUnused } from "../services/storedAssets.js";
import { getAIProvider, isRealImageProviderConfigured } from "../services/ai/index.js";

export const aiRouter = Router();
aiRouter.use(requireAuth);

// Only errors deliberately thrown with a .status (e.g. Openverse being down)
// are safe to show verbatim — anything else is an unexpected internal
// exception (bad input, a bug) and must not leak raw Node/library error
// text (stack internals, type-check messages, etc.) to the client.
function handleAIError(err, res) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

// Real generation draws on a limited free daily allowance, so cap each user.
const IMAGE_LIMIT = 10;
const TEXT_LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;
const imageLimit = createLimiter({ name: "ai-image", limit: IMAGE_LIMIT, windowMs: WINDOW_MS });
const WALLPAPER_LIMIT = 6; // each one can be several times the work of a plain picture
const wallpaperLimit = createLimiter({ name: "ai-wallpaper", limit: WALLPAPER_LIMIT, windowMs: WINDOW_MS });
const textLimit = createLimiter({ name: "ai-text", limit: TEXT_LIMIT, windowMs: WINDOW_MS });

aiRouter.post("/text", async (req, res) => {
  if (!req.body.prompt || typeof req.body.prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (isRealImageProviderConfigured() && !(await textLimit.allow(req.user.id))) {
    return res.status(429).json({ error: `Text limit reached (${TEXT_LIMIT} per hour) — try again later` });
  }
  try {
    const result = await getAIProvider().generateText({ prompt: req.body.prompt, kind: req.body.kind });
    res.json(result);
  } catch (err) {
    handleAIError(err, res);
  }
});

// Sent as JSON (a description), or as a form when a reference photo goes with it (see takeReference).
aiRouter.post("/image", readReference, async (req, res) => {
  if (!req.body?.prompt || typeof req.body.prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }
  const taken = takeReference(req, res);
  if (!taken) return;
  if (isRealImageProviderConfigured() && !(await imageLimit.allow(req.user.id))) {
    return res.status(429).json({ error: `Image limit reached (${IMAGE_LIMIT} per hour) — try again later` });
  }
  try {
    const result = await getAIProvider().generateImage({
      prompt: req.body.prompt,
      kind: req.body.kind,
      live: req.body.live === true || req.body.live === "true",
      reference: taken.reference,
      closeness: taken.closeness,
    });
    // Remember who generated a stored image so it can be deleted with its post.
    // (The mock provider returns inline data: URIs, which have nothing to clean up.)
    if (result.publicId) {
      await recordStoredAsset({ ownerId: req.user.id, url: result.url, publicId: result.publicId, kind: "ai" }).catch((err) =>
        console.error("Couldn't record generated image:", err)
      );
    }
    res.json({ url: result.url, usedReference: Boolean(taken.reference) });
  } catch (err) {
    handleAIError(err, res);
  }
});

// A wallpaper from a description, optionally reshaping a reference photo. The photo arrives with the request (never as a
// link for this server to fetch), is kept in memory only, and is checked by its own bytes.
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_WALLPAPER_PROMPT = 500;
const referenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_REFERENCE_BYTES, files: 1, fields: 5 } }).single("reference");

function readReference(req, res, next) {
  referenceUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "That photo is too large — use one under 4 MB." });
    return res.status(400).json({ error: "Couldn't read that upload." });
  });
}

// The reference photo (if any) and how closely to follow it, checked; answers the error and returns null if they are wrong.
function takeReference(req, res) {
  let reference = null;
  if (req.file) {
    const type = sniffImageType(req.file.buffer);
    if (!type) {
      res.status(400).json({ error: "The reference photo must be a JPEG, PNG or WebP picture." });
      return null;
    }
    reference = { buffer: req.file.buffer, mimetype: type };
  }
  const closeness = req.body?.closeness === undefined || req.body.closeness === "" ? "balanced" : req.body.closeness;
  if (!["close", "balanced", "loose"].includes(closeness)) {
    res.status(400).json({ error: "closeness must be close, balanced or loose" });
    return null;
  }
  return { reference, closeness };
}

aiRouter.post("/wallpaper", readReference, async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "prompt is required" });
  if (prompt.length > MAX_WALLPAPER_PROMPT) return res.status(400).json({ error: `Describe it in ${MAX_WALLPAPER_PROMPT} characters or fewer` });
  const taken = takeReference(req, res);
  if (!taken) return;
  const { reference, closeness } = taken;

  if (isRealImageProviderConfigured() && !(await wallpaperLimit.allow(req.user.id))) {
    return res.status(429).json({ error: `Wallpaper limit reached (${WALLPAPER_LIMIT} per hour) — try again later` });
  }
  try {
    const result = await getAIProvider().generateWallpaper({ prompt, reference, closeness });
    if (result.publicId) {
      await recordStoredAsset({ ownerId: req.user.id, url: result.url, publicId: result.publicId, kind: "ai" }).catch((err) =>
        console.error("Couldn't record generated wallpaper:", err)
      );
    }
    res.json({ url: result.url, usedReference: Boolean(reference) });
  } catch (err) {
    handleAIError(err, res);
  }
});

// A generated picture the person decided not to use: remove it from storage. Only what this person generated, and only if
// nothing (a wallpaper, a post, ...) uses it, is ever deleted, so this can't be used to remove anything else.
aiRouter.post("/discard", async (req, res) => {
  if (typeof req.body?.url !== "string" || !req.body.url) return res.status(400).json({ error: "url is required" });
  await deleteStoredAssetIfUnused({ ownerId: req.user.id, url: req.body.url });
  res.status(204).end();
});

aiRouter.get("/images/search", async (req, res) => {
  try {
    const results = await getAIProvider().searchImages(req.query.q || "");
    res.json({ results });
  } catch (err) {
    handleAIError(err, res);
  }
});
