import { Router } from "express";
import { currentSpotlights } from "../services/spotlights.js";

// The two artist spotlights on the main screen. Anyone can read them, signed in or not (a visitor sees them before they sign up), so only public
// facts about public profiles are given. An administrator chooses them (see routes/admin.routes.js).
export const spotlightsRouter = Router();

spotlightsRouter.get("/", async (req, res) => {
  // changes are rare and a minute's delay doesn't matter, so the busiest page on the site doesn't ask the database every time
  res.set("Cache-Control", "public, max-age=60");
  res.json({ spotlights: await currentSpotlights() });
});
