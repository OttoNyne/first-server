import { Router } from "express";
import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import { Invite, INVITE_KEEP_MS, INVITE_MAX_USES } from "../models/Invite.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { toPublicUser } from "../utils/serialize.js";
import { createLimiter } from "../utils/rateLimit.js";
import { clientIp } from "../utils/clientIp.js";
import { inviterForCode, usableFilter } from "../services/invites.js";

// Invite links: share one, and the person who signs up through it is your friend straight away. The link expires, is capped and can be
// switched off, and you are told (and can unfriend) everyone who comes in through it.
export const invitesRouter = Router();

const MAX_ACTIVE = 3;
const createLimiter_ = createLimiter({ name: "invite-create", limit: 10, windowMs: 24 * 60 * 60 * 1000 });
const previewLimiter = createLimiter({ name: "invite-preview", limit: 60, windowMs: 60 * 60 * 1000 });
const validId = (id) => mongoose.isValidObjectId(id);

async function shape(invite, viewerId) {
  const people = await User.find({ _id: { $in: invite.joined.map((j) => j.user) } });
  const byId = new Map(people.map((u) => [String(u._id), u]));
  const joined = [];
  for (const j of invite.joined) {
    const u = byId.get(String(j.user));
    if (u) joined.push({ user: await toPublicUser(u, viewerId), at: j.at });
  }
  return { id: invite._id, code: invite.code, uses: invite.uses, maxUses: invite.maxUses, expiresAt: invite.expireAt, createdAt: invite.createdAt, joined };
}

// Public on purpose (the person opening the link isn't signed in yet): who is inviting them. Every reason a link can't be used
// gets the same answer, and it is rate-limited so codes can't be guessed.
invitesRouter.get("/preview/:code", async (req, res) => {
  if (!(await previewLimiter.allow(clientIp(req)))) {
    res.set("Retry-After", String(previewLimiter.windowSeconds));
    return res.status(429).json({ error: "Too many tries — please wait a bit." });
  }
  const inviter = await inviterForCode(req.params.code);
  if (!inviter) return res.status(404).json({ error: "This invite link isn't valid any more" });
  res.json({ inviter: { username: inviter.username, displayName: inviter.displayName, avatarUrl: inviter.avatarUrl } });
});

invitesRouter.use(requireAuth);

// Your invites that can still be used, newest first, each with who came in through it.
invitesRouter.get("/", async (req, res) => {
  const invites = await Invite.find({ inviter: req.user.id, ...usableFilter() }).sort({ createdAt: -1 });
  res.json({ invites: await Promise.all(invites.map((i) => shape(i, req.user.id))) });
});

invitesRouter.post("/", requireVerifiedEmail, async (req, res) => {
  if ((await Invite.countDocuments({ inviter: req.user.id, ...usableFilter() })) >= MAX_ACTIVE) {
    return res.status(400).json({ error: `You can have ${MAX_ACTIVE} invite links at once — switch one off first` });
  }
  if (!(await createLimiter_.allow(req.user.id))) {
    res.set("Retry-After", String(createLimiter_.windowSeconds));
    return res.status(429).json({ error: "You've made a lot of invite links today — try again tomorrow." });
  }
  const invite = await Invite.create({ inviter: req.user.id, code: randomBytes(12).toString("base64url"), maxUses: INVITE_MAX_USES, expireAt: new Date(Date.now() + INVITE_KEEP_MS) });
  res.status(201).json({ invite: await shape(invite, req.user.id) });
});

// Switch a link off. Anyone who already came in through it stays your friend (unfriend them from the Friends page if you want).
invitesRouter.delete("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ error: "Invite not found" });
  const invite = await Invite.findOneAndUpdate({ _id: req.params.id, inviter: req.user.id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!invite) return res.status(404).json({ error: "Invite not found" });
  res.status(204).end();
});
