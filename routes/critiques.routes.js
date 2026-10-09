import { Router } from "express";
import mongoose from "mongoose";
import { Critique } from "../models/Critique.js";
import { CritiqueNote } from "../models/CritiqueNote.js";
import { MediaItem } from "../models/MediaItem.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { cleanBody } from "../utils/blogText.js";
import { cleanLine } from "../utils/profileFields.js";
import { countLinks, MAX_COMMENT_LINKS } from "../utils/commentInput.js";
import { cursorFilter } from "../utils/textInput.js";
import { visibleToViewer } from "../utils/visibility.js";
import { mutedUserIds } from "../utils/mutes.js";
import { deleteCritique } from "../services/removal.js";

// Critique requests: the owner of a portfolio piece asks for feedback on it (with an optional question), and people who can see the piece answer
// with two short notes, what is working and what they would change. The notes are for the owner only (and for the person who wrote each):
// everyone else sees how many there are. The owner can thank a note, take one away, or close the request. A request is the same 404 as a
// missing one for anyone who can't see its owner's profile.
export const critiquesRouter = Router();
critiquesRouter.use(requireAuth);

export const MAX_QUESTION = 300;
export const MAX_NOTE = 500;
export const MAX_OPEN = 3;
const PAGE = 20;
const SCAN = 60;
const ROUNDS = 3;
const askLimit = createLimiter({ name: "critique-ask", limit: 10, windowMs: 24 * 60 * 60 * 1000 });
const noteLimit = createLimiter({ name: "critique-note", limit: 30, windowMs: 24 * 60 * 60 * 1000 });
const bad = (res, error, status = 400) => res.status(status).json({ error });
const notFound = (res) => bad(res, "Request not found", 404);
const validId = (id) => mongoose.isValidObjectId(id);
const PEOPLE = "username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned suspendedAt isPrivate";
const person = (u) => ({ id: u._id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, csVerified: Boolean(u.csVerifiedByAdmin || u.csVerifiedEarned) });
const piecePreview = (m) => ({ id: m._id, url: m.url, type: m.type, caption: m.caption ?? null });

const toPublicNote = (n, author) => ({ id: n._id, working: n.working, change: n.change, thanked: n.thanked, createdAt: n.createdAt, editedAt: n.editedAt ?? null, ...(author ? { author: person(author) } : {}) });
function toPublicCritique(c, owner, piece, viewerId, extra = {}) {
  return { id: c._id, question: c.question, status: c.status, closed: c.status === "closed", createdAt: c.createdAt, owner: person(owner), mine: String(owner._id) === String(viewerId), piece: piecePreview(piece), ...extra };
}

/** Counts of notes for some requests: Map of request id → number. */
async function noteCounts(ids) {
  const rows = await CritiqueNote.aggregate([{ $match: { critique: { $in: ids } } }, { $group: { _id: "$critique", n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/** The request with its piece and owner, if the viewer may see it: the owner and anyone who wrote a note always can (while the owner's profile is visible), others only while it is open. */
async function loadVisible(id, viewerId) {
  if (!validId(id)) return null;
  const critique = await Critique.findById(id).populate("owner", PEOPLE).populate("piece");
  if (!critique?.owner || !critique.piece) return null;
  const may = await visibleToViewer(viewerId);
  if (!may(critique.owner)) return null;
  if (critique.status === "closed" && String(critique.owner._id) !== viewerId && !(await CritiqueNote.exists({ critique: critique._id, author: viewerId }))) return null;
  return critique;
}

/** Reads the two notes of a request body: each cleaned and at most 500 characters, at least one written, at most 3 links in all. Returns { value } or { error }. */
function readNote(body) {
  const out = {};
  for (const key of ["working", "change"]) {
    const raw = body?.[key];
    const text = raw === undefined || raw === null ? "" : typeof raw === "string" ? cleanBody(raw) : null;
    if (text === null) return { error: "Feedback must be text" };
    if ([...text].length > MAX_NOTE) return { error: `Each note can be up to ${MAX_NOTE} characters` };
    out[key] = text;
  }
  if (!out.working && !out.change) return { error: "Write something first" };
  if (countLinks(`${out.working} ${out.change}`) > MAX_COMMENT_LINKS) return { error: `Feedback can have up to ${MAX_COMMENT_LINKS} links` };
  return { value: out };
}

// Ask for feedback on one of your own pieces: `{ piece, question? }`. One open request per piece, three open in all.
critiquesRouter.post("/", async (req, res) => {
  const piece = validId(req.body?.piece) ? await MediaItem.findOne({ _id: req.body.piece, owner: req.user.id }) : null;
  if (!piece) return bad(res, "Choose one of your own pieces", 404);
  const raw = req.body?.question;
  const question = raw === undefined || raw === null ? "" : typeof raw === "string" ? cleanLine(raw) : null;
  if (question === null || [...question].length > MAX_QUESTION) return bad(res, `A question can be up to ${MAX_QUESTION} characters`);
  if (await Critique.exists({ piece: piece._id, status: "open" })) return bad(res, "This piece already has an open request", 409);
  if ((await Critique.countDocuments({ owner: req.user.id, status: "open" })) >= MAX_OPEN) return bad(res, `You can have up to ${MAX_OPEN} open requests — close one first`, 409);
  if (!(await askLimit.allow(req.user.id))) return bad(res, "You've asked for a lot of feedback today — try again tomorrow.", 429);
  const critique = await Critique.create({ piece: piece._id, owner: req.user.id, question });
  const owner = await User.findById(req.user.id).select(PEOPLE);
  res.status(201).json({ critique: toPublicCritique(critique, owner, piece, req.user.id, { noteCount: 0 }) });
});

// The board: open requests for feedback from people you can see (never your own, nor people you muted), newest first, 20 a page (?before=<id>).
critiquesRouter.get("/", async (req, res) => {
  const [may, muted] = await Promise.all([visibleToViewer(req.user.id), mutedUserIds(req.user.id)]);
  const mine = await CritiqueNote.find({ author: req.user.id }).select("critique").lean();
  const answered = new Set(mine.map((n) => String(n.critique)));
  const kept = [];
  let cursor = cursorFilter(req.query, mongoose);
  let exhausted = false;
  for (let round = 0; round < ROUNDS && kept.length <= PAGE; round++) {
    const found = await Critique.find({ status: "open", owner: { $ne: req.user.id }, ...(cursor ? { _id: { $lt: cursor } } : {}) })
      .sort({ _id: -1 })
      .limit(SCAN)
      .populate("owner", PEOPLE)
      .populate("piece");
    for (const c of found) {
      cursor = c._id;
      if (!c.piece || !may(c.owner) || muted.has(String(c.owner._id))) continue;
      kept.push(c);
      if (kept.length > PAGE) break;
    }
    if (found.length < SCAN) {
      exhausted = true;
      break;
    }
  }
  const shown = kept.slice(0, PAGE);
  const counts = await noteCounts(shown.map((c) => c._id));
  res.json({
    critiques: shown.map((c) => toPublicCritique(c, c.owner, c.piece, req.user.id, { noteCount: counts.get(String(c._id)) ?? 0, answered: answered.has(String(c._id)) })),
    hasMore: kept.length > PAGE || !exhausted,
    next: shown.length ? String(shown[shown.length - 1]._id) : null,
  });
});

// Your own requests, any state, newest first, with how many have answered.
critiquesRouter.get("/mine", async (req, res) => {
  const list = await Critique.find({ owner: req.user.id }).sort({ _id: -1 }).limit(50).populate("owner", PEOPLE).populate("piece");
  const counts = await noteCounts(list.map((c) => c._id));
  res.json({ critiques: list.filter((c) => c.piece).map((c) => toPublicCritique(c, c.owner, c.piece, req.user.id, { noteCount: counts.get(String(c._id)) ?? 0 })) });
});

// Requests you have answered, newest first.
critiquesRouter.get("/answered", async (req, res) => {
  const notes = await CritiqueNote.find({ author: req.user.id }).sort({ _id: -1 }).limit(50).populate({ path: "critique", populate: [{ path: "owner", select: PEOPLE }, { path: "piece" }] });
  const may = await visibleToViewer(req.user.id);
  res.json({
    answers: notes.filter((n) => n.critique?.owner && n.critique.piece && may(n.critique.owner)).map((n) => ({ note: toPublicNote(n), critique: toPublicCritique(n.critique, n.critique.owner, n.critique.piece, req.user.id) })),
  });
});

// One request. The owner also gets every note; someone who answered gets their own note; everyone else only the count.
critiquesRouter.get("/:id", async (req, res) => {
  const critique = await loadVisible(req.params.id, req.user.id);
  if (!critique) return notFound(res);
  const mine = String(critique.owner._id) === req.user.id;
  const [count, myNote] = await Promise.all([CritiqueNote.countDocuments({ critique: critique._id }), mine ? null : CritiqueNote.findOne({ critique: critique._id, author: req.user.id })]);
  const extra = { noteCount: count, myNote: myNote ? toPublicNote(myNote) : null };
  if (mine) {
    const notes = await CritiqueNote.find({ critique: critique._id }).sort({ _id: -1 }).populate("author", PEOPLE);
    extra.notes = notes.filter((n) => n.author && !n.author.suspendedAt).map((n) => toPublicNote(n, n.author));
  }
  res.json({ critique: toPublicCritique(critique, critique.owner, critique.piece, req.user.id, extra) });
});

// Change your request: its question, or close it / open it again (still one open per piece and three in all).
critiquesRouter.patch("/:id", async (req, res) => {
  const critique = validId(req.params.id) ? await Critique.findOne({ _id: req.params.id, owner: req.user.id }) : null;
  if (!critique) return notFound(res);
  if (req.body && Object.hasOwn(req.body, "question")) {
    const question = typeof req.body.question === "string" ? cleanLine(req.body.question) : null;
    if (question === null || [...question].length > MAX_QUESTION) return bad(res, `A question can be up to ${MAX_QUESTION} characters`);
    critique.question = question;
  }
  if (req.body && Object.hasOwn(req.body, "status")) {
    if (!["open", "closed"].includes(req.body.status)) return bad(res, "Status must be open or closed");
    if (req.body.status === "open" && critique.status === "closed") {
      if (await Critique.exists({ piece: critique.piece, status: "open" })) return bad(res, "This piece already has an open request", 409);
      if ((await Critique.countDocuments({ owner: req.user.id, status: "open" })) >= MAX_OPEN) return bad(res, `You can have up to ${MAX_OPEN} open requests — close one first`, 409);
    }
    critique.status = req.body.status;
    critique.closedAt = req.body.status === "closed" ? new Date() : null;
  }
  if (!critique.isModified()) return bad(res, "Nothing to change");
  await critique.save();
  const [owner, piece] = await Promise.all([User.findById(req.user.id).select(PEOPLE), MediaItem.findById(critique.piece)]);
  res.json({ critique: toPublicCritique(critique, owner, piece, req.user.id) });
});

// Take your request down, with its notes and the notices about it.
critiquesRouter.delete("/:id", async (req, res) => {
  const critique = validId(req.params.id) ? await Critique.findOne({ _id: req.params.id, owner: req.user.id }) : null;
  if (!critique) return notFound(res);
  await deleteCritique(critique);
  res.status(204).end();
});

// Answer a request: `{ working?, change? }`. Not on your own piece, once per person, only while it is open.
critiquesRouter.post("/:id/notes", async (req, res) => {
  const critique = await loadVisible(req.params.id, req.user.id);
  if (!critique) return notFound(res);
  if (String(critique.owner._id) === req.user.id) return bad(res, "You can't give feedback on your own piece");
  if (critique.status === "closed") return bad(res, "This request is closed", 409);
  const checked = readNote(req.body);
  if (checked.error) return bad(res, checked.error);
  if (await CritiqueNote.exists({ critique: critique._id, author: req.user.id })) return bad(res, "You have already given feedback on this", 409);
  if (!(await noteLimit.allow(req.user.id))) return bad(res, "You've given a lot of feedback today — try again tomorrow.", 429);
  let note;
  try {
    note = await CritiqueNote.create({ critique: critique._id, author: req.user.id, ...checked.value });
  } catch (err) {
    if (err?.code !== 11000) throw err; // two taps at once
    return bad(res, "You have already given feedback on this", 409);
  }
  await Notification.create({ recipient: critique.owner._id, type: "critique_note", payload: { actorId: String(req.user.id), critiqueId: String(critique._id), title: critique.piece.caption ?? "" } });
  res.status(201).json({ note: toPublicNote(note) });
});

// Change your note while the request is open, or take it back.
critiquesRouter.patch("/:id/notes/mine", async (req, res) => {
  const critique = await loadVisible(req.params.id, req.user.id);
  const note = critique ? await CritiqueNote.findOne({ critique: critique._id, author: req.user.id }) : null;
  if (!note) return bad(res, "Feedback not found", 404);
  if (critique.status === "closed") return bad(res, "This request is closed", 409);
  const checked = readNote(req.body);
  if (checked.error) return bad(res, checked.error);
  note.working = checked.value.working;
  note.change = checked.value.change;
  note.editedAt = new Date();
  await note.save();
  res.json({ note: toPublicNote(note) });
});

critiquesRouter.delete("/:id/notes/mine", async (req, res) => {
  const critique = validId(req.params.id) ? await Critique.findById(req.params.id) : null;
  const note = critique ? await CritiqueNote.findOne({ critique: critique._id, author: req.user.id }) : null;
  if (!note) return bad(res, "Feedback not found", 404);
  await note.deleteOne();
  await Notification.deleteMany({ type: "critique_note", recipient: critique.owner, "payload.critiqueId": String(critique._id), "payload.actorId": String(req.user.id) });
  res.status(204).end();
});

// The owner says thank you for a note (the writer is told once, however often it is pressed), or takes it back.
critiquesRouter.put("/:id/notes/:noteId/thanks", async (req, res) => {
  const critique = validId(req.params.id) ? await Critique.findOne({ _id: req.params.id, owner: req.user.id }) : null;
  const note = critique && validId(req.params.noteId) ? await CritiqueNote.findOne({ _id: req.params.noteId, critique: critique._id }) : null;
  if (!note) return bad(res, "Feedback not found", 404);
  if (!note.thanked) {
    note.thanked = true;
    await note.save();
    await Notification.create({ recipient: note.author, type: "critique_thanks", payload: { actorId: String(req.user.id), critiqueId: String(critique._id) } });
  }
  res.json({ note: toPublicNote(note) });
});

// The owner takes a note away (an abusive one, say): 204.
critiquesRouter.delete("/:id/notes/:noteId", async (req, res) => {
  const critique = validId(req.params.id) ? await Critique.findOne({ _id: req.params.id, owner: req.user.id }) : null;
  const note = critique && validId(req.params.noteId) ? await CritiqueNote.findOne({ _id: req.params.noteId, critique: critique._id }) : null;
  if (!note) return bad(res, "Feedback not found", 404);
  await note.deleteOne();
  res.status(204).end();
});
