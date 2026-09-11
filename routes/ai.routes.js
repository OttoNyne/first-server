import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getAIProvider } from "../services/ai/index.js";

export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.post("/text", async (req, res) => {
  try {
    const result = await getAIProvider().generateText({ prompt: req.body.prompt, kind: req.body.kind });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

aiRouter.post("/image", async (req, res) => {
  try {
    const result = await getAIProvider().generateImage({
      prompt: req.body.prompt,
      kind: req.body.kind,
      live: req.body.live,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

aiRouter.get("/images/search", async (req, res) => {
  try {
    const results = await getAIProvider().searchImages(req.query.q || "");
    res.json({ results });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
