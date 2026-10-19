import { Router } from "express";
import mongoose from "mongoose";
import { Report } from "../models/Report.js";
import { ModerationAction } from "../models/ModerationAction.js";
import { User } from "../models/User.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { toPublicUser } from "../utils/serialize.js";
import { cleanBody } from "../utils/blogText.js";
import { REPORT_TYPES, liftSuspension, loadTarget, resolveCase } from "../services/moderation.js";
import { giveByAdmin, removeByAdmin } from "../services/csVerified.js";
import { Spotlight } from "../models/Spotlight.js";
import { MediaItem } from "../models/MediaItem.js";
import { checkLine } from "../utils/profileFields.js";
import { MAX_NOTE, SLOTS, adminSlots, hiddenReason } from "../services/spotlights.js";

// The moderation review queue. Everything here is for administrators only (see middleware/requireAdmin.js) and answers 404 to anyone else.
export const adminRouter = Router();
adminRouter.use(requireAdmin);

const PAGE = 20;
const REPORTS_SHOWN_PER_CASE = 10;
const page = (req) => Math.min(100, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
const ACTIONS = ["dismiss", "remove", "suspend", "remove_and_suspend"];

// Open reports, grouped by what was reported (so five people reporting one post is one case), the most recently reported first.
adminRouter.get("/reports", async (req, res) => {
  const p = page(req);
  const grouped = await Report.aggregate([
    { $match: { status: "open" } },
    { $group: { _id: { targetType: "$targetType", targetId: "$targetId" }, count: { $sum: 1 }, latest: { $max: "$createdAt" } } },
    { $sort: { latest: -1, "_id.targetId": 1 } },
    { $skip: (p - 1) * PAGE },
    { $limit: PAGE + 1 },
  ]);
  const cases = [];
  for (const g of grouped.slice(0, PAGE)) {
    const { targetType, targetId } = g._id;
    const [target, reports] = await Promise.all([
      loadTarget(targetType, targetId, req.user.id),
      Report.find({ targetType, targetId, status: "open" }).sort({ createdAt: -1 }).limit(REPORTS_SHOWN_PER_CASE).populate("reporter"),
    ]);
    cases.push({
      targetType,
      targetId,
      exists: target.exists,
      target: target.preview ?? null,
      count: g.count,
      reports: await Promise.all(reports.map(async (r) => ({ id: r._id, reason: r.reason, createdAt: r.createdAt, reporter: r.reporter ? await toPublicUser(r.reporter, req.user.id) : null }))),
    });
  }
  res.json({ cases, page: p, hasMore: grouped.length > PAGE });
});

// A decision on everything reported about one thing.
adminRouter.post("/reports/resolve", async (req, res) => {
  const { targetType, targetId, action } = req.body ?? {};
  if (!REPORT_TYPES.includes(targetType) || !mongoose.isValidObjectId(targetId)) return res.status(400).json({ error: "Say which report" });
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: `action must be one of: ${ACTIONS.join(", ")}` });
  const note = typeof req.body.note === "string" ? cleanBody(req.body.note) : "";
  if (note.length > 500) return res.status(400).json({ error: "Notes can be up to 500 characters" });
  const result = await resolveCase({ adminId: req.user.id, targetType, targetId, action, note });
  if (result.error) return res.status(result.status ?? 400).json({ error: result.error });
  res.json({ outcome: result.outcome, removed: result.removed });
});

// What moderators have done, newest first.
adminRouter.get("/actions", async (req, res) => {
  const p = page(req);
  const found = await ModerationAction.find().sort({ createdAt: -1, _id: -1 }).skip((p - 1) * PAGE).limit(PAGE + 1).populate("admin").populate("subject");
  const actions = await Promise.all(
    found.slice(0, PAGE).map(async (a) => ({
      id: a._id,
      targetType: a.targetType,
      targetId: a.targetId,
      action: a.action,
      note: a.note,
      reportCount: a.reportCount,
      createdAt: a.createdAt,
      admin: a.admin ? await toPublicUser(a.admin, req.user.id) : null,
      subject: a.subject ? await toPublicUser(a.subject, req.user.id) : null,
    }))
  );
  res.json({ actions, page: p, hasMore: found.length > PAGE });
});

// Suspended accounts, with the note the moderator left.
adminRouter.get("/suspended", async (req, res) => {
  const p = page(req);
  const found = await User.find({ suspendedAt: { $ne: null } }).sort({ suspendedAt: -1 }).skip((p - 1) * PAGE).limit(PAGE + 1);
  res.json({
    users: await Promise.all(found.slice(0, PAGE).map(async (u) => ({ user: await toPublicUser(u, req.user.id), suspendedAt: u.suspendedAt, note: u.suspensionNote ?? "" }))),
    page: p,
    hasMore: found.length > PAGE,
  });
});

// The CSverified badge: who an administrator has given it to, giving it, and taking it away. A badge someone earned with friends is
// separate (see services/csVerified.js) and isn't touched here. Each change is kept in the moderation record.
adminRouter.get("/verified", async (req, res) => {
  const p = page(req);
  const found = await User.find({ csVerifiedByAdmin: true }).sort({ csVerifiedAdminAt: -1, _id: -1 }).skip((p - 1) * PAGE).limit(PAGE + 1);
  res.json({
    users: await Promise.all(found.slice(0, PAGE).map(async (u) => ({ user: await toPublicUser(u, req.user.id), givenAt: u.csVerifiedAdminAt }))),
    page: p,
    hasMore: found.length > PAGE,
  });
});

const findForBadge = (username) => User.findOne({ username: String(username).trim().toLowerCase().replace(/^@/, "") });

adminRouter.put("/verified/:username", async (req, res) => {
  const user = await findForBadge(req.params.username);
  if (!user) return res.status(404).json({ error: "No one has that username" });
  if (user.suspendedAt) return res.status(400).json({ error: "That account is suspended" });
  const given = await giveByAdmin(user);
  if (given) await ModerationAction.create({ admin: req.user.id, targetType: "user", targetId: user._id, subject: user._id, action: "verified", note: "", reportCount: 0 });
  res.json({ user: await toPublicUser(user, req.user.id), given });
});

adminRouter.delete("/verified/:username", async (req, res) => {
  const user = await findForBadge(req.params.username);
  if (!user) return res.status(404).json({ error: "No one has that username" });
  if (!(await removeByAdmin(user))) return res.status(404).json({ error: "That person doesn't have a badge from an administrator" });
  await ModerationAction.create({ admin: req.user.id, targetType: "user", targetId: user._id, subject: user._id, action: "unverified", note: "", reportCount: 0 });
  res.status(204).end();
});

// ---- The two artist spotlights on the main screen ------------------------------------------------------
const slotOf = (req) => (SLOTS.includes(Number(req.params.slot)) ? Number(req.params.slot) : null);

adminRouter.get("/spotlights", async (req, res) => {
  res.json({ slots: await adminSlots(), maxNote: MAX_NOTE });
});

// Put a person in a slot (replacing whoever was there): `{ username, note?, pieceId? }`. They must be able to be shown (a public, unsuspended
// profile) and can hold only one slot; `pieceId` must be one of their own pictures (leave it out for their featured piece, else their latest).
adminRouter.put("/spotlights/:slot", async (req, res) => {
  const slot = slotOf(req);
  if (!slot) return res.status(404).json({ error: "That slot doesn't exist" });
  const user = await findForBadge(req.body?.username ?? "");
  if (!user) return res.status(404).json({ error: "No one has that username" });
  if (user.suspendedAt) return res.status(400).json({ error: "That account is suspended" });
  const reason = hiddenReason(user);
  if (reason === "private") return res.status(400).json({ error: "That profile is private, so it can't be shown on the main screen" });
  let note = "";
  if (req.body?.note !== undefined && req.body.note !== null) {
    const checked = checkLine(req.body.note, MAX_NOTE, "Spotlight note");
    if (checked.error) return res.status(400).json({ error: checked.error });
    note = checked.value;
  }
  let piece = null;
  if (req.body?.pieceId !== undefined && req.body.pieceId !== null && req.body.pieceId !== "") {
    const found = mongoose.isValidObjectId(req.body.pieceId) ? await MediaItem.findOne({ _id: req.body.pieceId, owner: user._id, type: "image" }) : null;
    if (!found) return res.status(400).json({ error: "Pick one of their pictures, or leave it automatic" });
    piece = found._id;
  }
  const other = SLOTS.find((s) => s !== slot);
  if (await Spotlight.exists({ slot: other, user: user._id })) return res.status(409).json({ error: "That person is already in the other slot" });
  await Spotlight.findOneAndUpdate({ slot }, { $set: { user: user._id, piece, note, setBy: req.user.id } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
  res.json({ slots: await adminSlots(), maxNote: MAX_NOTE });
});

adminRouter.delete("/spotlights/:slot", async (req, res) => {
  const slot = slotOf(req);
  if (!slot) return res.status(404).json({ error: "That slot doesn't exist" });
  if (!(await Spotlight.findOneAndDelete({ slot }))) return res.status(404).json({ error: "That slot is empty" });
  res.status(204).end();
});

adminRouter.post("/users/:id/unsuspend", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  if (!(await liftSuspension(req.user.id, req.params.id))) return res.status(404).json({ error: "That account isn't suspended" });
  res.status(204).end();
});
