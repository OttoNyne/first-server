import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { recordStoredAsset } from "../services/storedAssets.js";
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

aiRouter.post("/image", async (req, res) => {
  if (!req.body.prompt || typeof req.body.prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (isRealImageProviderConfigured() && !(await imageLimit.allow(req.user.id))) {
    return res.status(429).json({ error: `Image limit reached (${IMAGE_LIMIT} per hour) — try again later` });
  }
  try {
    const result = await getAIProvider().generateImage({
      prompt: req.body.prompt,
      kind: req.body.kind,
      live: req.body.live,
    });
    // Remember who generated a stored image so it can be deleted with its post.
    // (The mock provider returns inline data: URIs, which have nothing to clean up.)
    if (result.publicId) {
      await recordStoredAsset({ ownerId: req.user.id, url: result.url, publicId: result.publicId, kind: "ai" }).catch((err) =>
        console.error("Couldn't record generated image:", err)
      );
    }
    res.json({ url: result.url });
  } catch (err) {
    handleAIError(err, res);
  }
});

aiRouter.get("/images/search", async (req, res) => {
  try {
    const results = await getAIProvider().searchImages(req.query.q || "");
    res.json({ results });
  } catch (err) {
    handleAIError(err, res);
  }
});
