import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { Chain } from "../models/Chain.js";
import { ChainSection } from "../models/ChainSection.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanLine } from "../utils/profileFields.js";
import { checkPng } from "../utils/png.js";
import { isAdminUser } from "../utils/admin.js";
import { visibleToViewer } from "../utils/visibility.js";
import { CHAIN_PARTS, CLAIM_MINUTES, EDGE_HEIGHT, MAX_EDGE_BYTES, MAX_OPEN_OWN, MAX_PROMPT, MAX_SECTION_BYTES, SECTION_HEIGHT, SECTION_WIDTH, deleteChain } from "../services/chains.js";

// Exquisite-corpse chains: a drawing in three parts, each by a different person who is shown only a thin strip of the part before, so
// nobody sees the whole until the last part is in. Anyone signed in can start one (drawing the first part) or take the next part of one that is
// waiting. Taking a part claims it for a little while, so two people are never drawing the same one. Until a chain is finished only that strip
// is given out, and each part is kept as the PNG the sketchpad made (see models/ChainSection.js). A finished chain is shown to everyone signed in,
// with who drew which part. Only public profiles take part, because of that.
export const chainsRouter = Router();
chainsRouter.use(requireAuth);

export const PAGE = 12;
const startLimit = createLimiter({ name: "chain-start", limit: 6, windowMs: 24 * 60 * 60 * 1000 });
const partLimit = createLimiter({ name: "chain-part", limit: 30, windowMs: 24 * 60 * 60 * 1000 });
const claimLimit = createLimiter({ name: "chain-claim", limit: 40, windowMs: 24 * 60 * 60 * 1000 });
const bad = (res, error, status = 400) => res.status(status).json({ error });
const notFound = (res) => bad(res, "Chain not found", 404);
const validId = (id) => mongoose.isValidObjectId(id);
const PEOPLE = "username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned suspendedAt isPrivate";
const person = (u) => ({ id: u._id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, csVerified: Boolean(u.csVerifiedByAdmin || u.csVerifiedEarned) });
const imageUrl = (chainId, index) => `/api/chains/${chainId}/sections/${index}/image`;

// The two pictures of a part arrive as a form: `section` (the whole part) and `edge` (its bottom strip, for every part but the last), and for a
// new chain the words of its prompt.
const take = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SECTION_BYTES, files: 2, fields: 4, parts: 8 } }).fields([
  { name: "section", maxCount: 1 },
  { name: "edge", maxCount: 1 },
]);
function readForm(req, res, next) {
  take(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return bad(res, "That drawing is too large", 413);
    return bad(res, "Couldn't read that drawing");
  });
}

/** The part's picture and its edge from the form, checked; `{ error, status }` if either is wrong. `needEdge` is false for the last part. */
function readPictures(req, needEdge) {
  const section = req.files?.section?.[0]?.buffer;
  const edge = req.files?.edge?.[0]?.buffer ?? null;
  const part = checkPng(section, { width: SECTION_WIDTH, height: SECTION_HEIGHT, maxBytes: MAX_SECTION_BYTES });
  if (part.error) return { error: section ? part.error : "Draw something first", status: part.status };
  if (needEdge) {
    const strip = checkPng(edge, { width: SECTION_WIDTH, height: EDGE_HEIGHT, maxBytes: MAX_EDGE_BYTES });
    if (strip.error) return { error: strip.error, status: strip.status };
  }
  return { section, edge: needEdge ? edge : null };
}

async function mayTakePart(userId) {
  const user = await User.findById(userId).select("isPrivate");
  return user && !user.isPrivate;
}
const PRIVATE_MESSAGE = "Chains are shown to everyone, so only public profiles can take part. Make your profile public to join one.";

const claimedBy = (chain, userId, now = new Date()) => Boolean(chain.claimUser && String(chain.claimUser) === String(userId) && chain.claimUntil > now);
const claimOpen = (now) => ({ $or: [{ claimUser: null }, { claimUntil: null }, { claimUntil: { $lte: now } }] });

/** Chains whose every contributor this viewer may be shown (public, not suspended, not blocked either way). */
async function shown(chains, viewerId) {
  if (!chains.length) return [];
  const ids = [...new Set(chains.flatMap((c) => c.contributors.map(String)))];
  const users = await User.find({ _id: { $in: ids } }).select(PEOPLE);
  const may = await visibleToViewer(viewerId);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return chains.filter((c) => c.contributors.every((id) => may(byId.get(String(id)))));
}

/** The parts of some finished chains, with who drew each (the pictures are fetched from their own addresses). */
async function withSections(chains, viewerId) {
  const sections = await ChainSection.find({ chain: { $in: chains.map((c) => c._id) } }).sort({ index: 1 });
  const users = await User.find({ _id: { $in: [...new Set(sections.map((s) => String(s.author)))] } }).select(PEOPLE);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return chains.map((c) => ({
    id: c._id,
    prompt: c.prompt,
    status: c.status,
    complete: c.status === "complete",
    count: c.count,
    parts: CHAIN_PARTS,
    completedAt: c.completedAt,
    mine: c.contributors.some((id) => String(id) === String(viewerId)),
    sections: c.status === "complete"
      ? sections.filter((s) => String(s.chain) === String(c._id)).map((s) => ({ id: s._id, index: s.index, author: byId.has(String(s.author)) ? person(byId.get(String(s.author))) : null, imageUrl: imageUrl(c._id, s.index) }))
      : [],
  }));
}

/** A chain waiting for its next part, as the board shows it: how far along, what to expect, and where the strip to continue from is. */
const waiting = (c, viewerId) => ({ id: c._id, prompt: c.prompt, count: c.count, parts: CHAIN_PARTS, nextPart: c.count + 1, edgeUrl: `/api/chains/${c._id}/edge`, claimedByMe: claimedBy(c, viewerId) });

// Chains waiting for someone to take the next part: not ones you have drawn on, and not ones someone else is drawing right now. Oldest wait first.
chainsRouter.get("/open", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const now = new Date();
  const found = await Chain.find({ status: "open", contributors: { $ne: req.user.id }, $or: [{ claimUser: req.user.id, claimUntil: { $gt: now } }, claimOpen(now)] })
    .sort({ updatedAt: 1 })
    .skip((page - 1) * PAGE)
    .limit(PAGE + 1);
  const visible = await shown(found.slice(0, PAGE), req.user.id);
  res.json({ chains: visible.map((c) => waiting(c, req.user.id)), hasMore: found.length > PAGE });
});

// Finished chains, newest first.
chainsRouter.get("/complete", async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const found = await Chain.find({ status: "complete" })
    .sort({ completedAt: -1 })
    .skip((page - 1) * PAGE)
    .limit(PAGE + 1);
  const visible = await shown(found.slice(0, PAGE), req.user.id);
  res.json({ chains: await withSections(visible, req.user.id), hasMore: found.length > PAGE });
});

// The chains you have drawn a part of, finished or not.
chainsRouter.get("/mine", async (req, res) => {
  const found = await Chain.find({ contributors: req.user.id }).sort({ updatedAt: -1 }).limit(30);
  const list = await withSections(found, req.user.id);
  res.json({ chains: list.map((c, i) => ({ ...c, canDelete: c.status === "open" && String(found[i].creator) === String(req.user.id) })) });
});

// Start a chain by drawing its first part: a form with `section`, `edge` and an optional `prompt`.
chainsRouter.post("/", readForm, async (req, res) => {
  if (!(await mayTakePart(req.user.id))) return bad(res, PRIVATE_MESSAGE, 403);
  const prompt = cleanLine(typeof req.body?.prompt === "string" ? req.body.prompt : "");
  if ([...prompt].length > MAX_PROMPT) return bad(res, `The idea can be up to ${MAX_PROMPT} characters`);
  const pictures = readPictures(req, true);
  if (pictures.error) return bad(res, pictures.error, pictures.status);
  if ((await Chain.countDocuments({ creator: req.user.id, status: "open" })) >= MAX_OPEN_OWN) return bad(res, `You already have ${MAX_OPEN_OWN} chains waiting for someone to continue them`, 409);
  if (!(await startLimit.allow(req.user.id))) return bad(res, "You've started a lot of chains today — try again tomorrow.", 429);

  const chain = await Chain.create({ creator: req.user.id, prompt, count: 1, contributors: [req.user.id] });
  try {
    await ChainSection.create({ chain: chain._id, index: 0, author: req.user.id, png: pictures.section, edge: pictures.edge });
  } catch (err) {
    await Chain.deleteOne({ _id: chain._id });
    throw err;
  }
  res.status(201).json({ chain: waiting(chain, req.user.id) });
});

// One chain: a finished one in full, one still waiting just as far along as it is (a person can learn no more than that).
chainsRouter.get("/:id", async (req, res) => {
  const chain = validId(req.params.id) ? await Chain.findById(req.params.id) : null;
  if (!chain || !(await shown([chain], req.user.id)).length) return notFound(res);
  const [item] = await withSections([chain], req.user.id);
  res.json({ chain: { ...item, canDelete: chain.status === "open" && String(chain.creator) === String(req.user.id), claimedByMe: claimedBy(chain, req.user.id) } });
});

// Take the next part: it is yours to draw for a while. The same person asking again just gets the time they have left.
chainsRouter.post("/:id/claim", async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  if (!(await mayTakePart(req.user.id))) return bad(res, PRIVATE_MESSAGE, 403);
  const existing = await Chain.findById(req.params.id);
  if (!existing || !(await shown([existing], req.user.id)).length) return notFound(res);
  if (existing.status !== "open") return bad(res, "That chain is finished", 409);
  if (existing.contributors.some((id) => String(id) === String(req.user.id))) return bad(res, "You have already drawn a part of this chain", 403);
  const mineAlready = claimedBy(existing, req.user.id);
  if (!mineAlready && !(await claimLimit.allow(req.user.id))) return bad(res, "You've taken a lot of parts today — try again tomorrow.", 429);

  const now = new Date();
  const until = new Date(now.getTime() + CLAIM_MINUTES * 60 * 1000);
  // one step decides who gets it: only a chain nobody is drawing (or that this person already holds) can be claimed
  const chain = await Chain.findOneAndUpdate(
    { _id: existing._id, status: "open", contributors: { $ne: req.user.id }, $or: [{ claimUser: req.user.id, claimUntil: { $gt: now } }, claimOpen(now)] },
    { $set: { claimUser: req.user.id, claimUntil: mineAlready ? existing.claimUntil : until } },
    { returnDocument: "after" }
  );
  if (!chain) return bad(res, "Someone else is drawing the next part right now — try another chain, or come back in a little while.", 409);
  res.json({ chain: waiting(chain, req.user.id), claimedUntil: chain.claimUntil, minutes: CLAIM_MINUTES });
});

// Give the part back (you left without drawing it), so someone else can take it.
chainsRouter.delete("/:id/claim", async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  await Chain.updateOne({ _id: req.params.id, claimUser: req.user.id }, { $set: { claimUser: null, claimUntil: null } });
  res.status(204).end();
});

// Draw the part you have claimed: a form with `section` and (unless it is the last part) `edge`.
chainsRouter.post("/:id/sections", readForm, async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const now = new Date();
  const current = await Chain.findOne({ _id: req.params.id, status: "open" });
  if (!current) return notFound(res);
  if (!claimedBy(current, req.user.id, now)) return bad(res, "Take this part first — the time you had to draw it has run out, or someone else has it.", 409);
  const pictures = readPictures(req, current.count + 1 < CHAIN_PARTS);
  if (pictures.error) return bad(res, pictures.error, pictures.status);
  if (!(await partLimit.allow(req.user.id))) return bad(res, "You've drawn a lot of parts today — try again tomorrow.", 429);

  // one step uses up the claim, counts the part and (for the last) finishes the chain, so two requests can't both add a part
  const chain = await Chain.findOneAndUpdate(
    { _id: current._id, status: "open", claimUser: req.user.id, claimUntil: { $gt: now }, count: current.count, contributors: { $ne: req.user.id } },
    [
      {
        $set: {
          count: { $add: ["$count", 1] },
          contributors: { $concatArrays: ["$contributors", [new mongoose.Types.ObjectId(req.user.id)]] },
          claimUser: null,
          claimUntil: null,
          status: { $cond: [{ $gte: [{ $add: ["$count", 1] }, CHAIN_PARTS] }, "complete", "open"] },
          completedAt: { $cond: [{ $gte: [{ $add: ["$count", 1] }, CHAIN_PARTS] }, now, null] },
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true }
  );
  if (!chain) return bad(res, "Take this part first — the time you had to draw it has run out, or someone else has it.", 409);
  try {
    await ChainSection.create({ chain: chain._id, index: chain.count - 1, author: req.user.id, png: pictures.section, edge: pictures.edge });
  } catch (err) {
    // the part didn't save: give the chain back as it was
    await Chain.updateOne({ _id: chain._id }, { $inc: { count: -1 }, $pull: { contributors: req.user.id }, $set: { status: "open", completedAt: null } });
    throw err;
  }
  if (chain.status === "complete") {
    const others = chain.contributors.filter((id) => String(id) !== String(req.user.id));
    if (others.length) await Notification.insertMany(others.map((recipient) => ({ recipient, type: "chain_done", payload: { actorId: String(req.user.id), chainId: String(chain._id), prompt: chain.prompt } })));
  }
  const [item] = await withSections([chain], req.user.id);
  res.status(201).json({ chain: item });
});

// Take back a chain you started, as long as it isn't finished: a finished chain belongs to everyone who drew on it.
chainsRouter.delete("/:id", async (req, res) => {
  const chain = validId(req.params.id) ? await Chain.findById(req.params.id) : null;
  if (!chain || String(chain.creator) !== String(req.user.id)) return notFound(res);
  if (chain.status === "complete") return bad(res, "A finished chain belongs to everyone who drew on it", 403);
  await deleteChain(chain._id);
  res.status(204).end();
});

function sendPng(res, buffer, cache) {
  res.set({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": cache, "Content-Length": String(buffer.length) });
  res.send(buffer);
}

// The strip along the bottom of the last drawn part: only to the person who holds the claim (to draw from), or a moderator.
chainsRouter.get("/:id/edge", async (req, res) => {
  const chain = validId(req.params.id) ? await Chain.findById(req.params.id) : null;
  if (!chain || chain.status !== "open" || chain.count < 1) return notFound(res);
  if (!claimedBy(chain, req.user.id) && !isAdminUser(await User.findById(req.user.id).select("email emailVerified"))) return notFound(res);
  const section = await ChainSection.findOne({ chain: chain._id, index: chain.count - 1 }).select("+edge");
  if (!section?.edge) return notFound(res);
  sendPng(res, section.edge, "private, max-age=60");
});

// A part's whole picture: to anyone who may see a finished chain, to the person who drew it, and to a moderator.
chainsRouter.get("/:id/sections/:index/image", async (req, res) => {
  const index = Number(req.params.index);
  const chain = validId(req.params.id) && Number.isInteger(index) ? await Chain.findById(req.params.id) : null;
  if (!chain) return notFound(res);
  const section = await ChainSection.findOne({ chain: chain._id, index }).select("+png");
  if (!section) return notFound(res);
  const mine = String(section.author) === String(req.user.id);
  const visible = chain.status === "complete" && (await shown([chain], req.user.id)).length > 0;
  if (!mine && !visible && !isAdminUser(await User.findById(req.user.id).select("email emailVerified"))) return notFound(res);
  sendPng(res, section.png, chain.status === "complete" ? "private, max-age=3600" : "private, no-store");
});
