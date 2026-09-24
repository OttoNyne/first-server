import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
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

// Real generation draws on a limited free daily allowance, so cap each user. In-memory is
// fine for a single instance; it resets on restart, which only ever errs
// toward allowing a few extra generations.
const IMAGE_LIMIT = 10;
const TEXT_LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;
const imageUsage = new Map();
const textUsage = new Map();

function withinLimit(usage, userId, limit) {
  const now = Date.now();
  const recent = (usage.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    usage.set(userId, recent);
    return false;
  }
  recent.push(now);
  usage.set(userId, recent);
  return true;
}

aiRouter.post("/text", async (req, res) => {
  if (!req.body.prompt || typeof req.body.prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (isRealImageProviderConfigured() && !withinLimit(textUsage, req.user.id, TEXT_LIMIT)) {
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
  if (isRealImageProviderConfigured() && !withinLimit(imageUsage, req.user.id, IMAGE_LIMIT)) {
    return res.status(429).json({ error: `Image limit reached (${IMAGE_LIMIT} per hour) — try again later` });
  }
  try {
    const result = await getAIProvider().generateImage({
      prompt: req.body.prompt,
      kind: req.body.kind,
      live: req.body.live,
    });
    res.json(result);
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
