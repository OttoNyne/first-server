import { User } from "../models/User.js";
import { Mute } from "../models/Mute.js";
import { cleanLine, isValidTag, MAX_TAG, MIN_TAG, normalizeTag } from "./profileFields.js";
import { cleanBody } from "./blogText.js";
import { checkDeadline } from "../routes/workRequests.routes.js";
import { areFriends, blockedUserIds } from "./visibility.js";
import { escapeRegex } from "./regex.js";

export const MAX_TITLE = 80;
export const MAX_DETAILS = 1500;
export const MAX_BUDGET = 40;
export const MAX_ROLES = 5;
export const MAX_NOTE = 500;
export const MAX_REPLY = 300;
export const MAX_OPEN_CALLS = 5;
export const MAX_APPLICATIONS = 100;
export const MATCH_NOTICES = 20; // how many people are told about a new call
export const MATCHES_SHOWN = 12;
const DAY = 24 * 60 * 60 * 1000;

/**
 * What a call is made of, from a request body. `partial` (changing one) only checks and returns the fields that were sent.
 * Returns { value } with title, details, lookingFor, budget, deadline (a Date or null) or { error }.
 */
export function readCall(body, { partial = false, now = new Date() } = {}) {
  const out = {};
  const sent = (key) => body && Object.hasOwn(body, key);

  if (!partial || sent("title")) {
    const title = typeof body?.title === "string" ? cleanLine(body.title) : "";
    if (!title) return { error: "Give your call a title" };
    if ([...title].length > MAX_TITLE) return { error: `Titles can be up to ${MAX_TITLE} characters` };
    out.title = title;
  }
  if (!partial || sent("details")) {
    const details = typeof body?.details === "string" ? cleanBody(body.details) : "";
    if (!details) return { error: "Say what you are looking for" };
    if ([...details].length > MAX_DETAILS) return { error: `Details can be up to ${MAX_DETAILS} characters` };
    out.details = details;
  }
  if (!partial || sent("lookingFor")) {
    const list = body?.lookingFor ?? [];
    if (!Array.isArray(list)) return { error: "Roles must be a list" };
    const seen = new Set();
    for (const raw of list) {
      if (typeof raw !== "string") return { error: "Roles must be text" };
      const tag = normalizeTag(raw);
      if (!isValidTag(tag)) return { error: `"${cleanLine(raw).slice(0, 30)}" isn't a valid tag — use ${MIN_TAG}–${MAX_TAG} letters, numbers, spaces or hyphens` };
      seen.add(tag);
    }
    if (seen.size > MAX_ROLES) return { error: `A call can look for up to ${MAX_ROLES} roles` };
    out.lookingFor = [...seen];
  }
  if (!partial || sent("budget")) {
    const raw = body?.budget;
    const budget = raw === undefined || raw === null ? "" : typeof raw === "string" ? cleanLine(raw) : null;
    if (budget === null || [...budget].length > MAX_BUDGET) return { error: `Budgets can be up to ${MAX_BUDGET} characters` };
    out.budget = budget;
  }
  if (!partial || sent("deadline")) {
    const deadline = checkDeadline(body?.deadline, now);
    if (deadline.error) return { error: deadline.error };
    out.deadline = deadline.value;
  }
  return { value: out };
}

/** Whether a call no longer takes applications: closed by its owner, or its last day has passed. */
export const isClosed = (call, now = Date.now()) => call.status === "closed" || Boolean(call.deadline && new Date(call.deadline).getTime() + DAY <= now);

/** The start of today (UTC): a call whose deadline is earlier than this has ended. */
export const startOfToday = (now = Date.now()) => new Date(Math.floor(now / DAY) * DAY);

const wordsOf = (tag) => tag.split(/[\s-]+/).filter((w) => w.length >= 3);

/** Which of the things a call looks for fit a person's tags and offers: the same tag, or one that shares a word of three letters or more. */
export function matchedRoles(lookingFor, person) {
  const theirs = [...(person.workOffers ?? []), ...(person.tags ?? [])].map((t) => String(t).toLowerCase());
  const exact = new Set(theirs);
  const words = new Set(theirs.flatMap(wordsOf));
  return (lookingFor ?? []).filter((role) => exact.has(role) || wordsOf(role).some((w) => words.has(w)));
}

/** The people who might fit a call: open to work, with something in common with what it looks for, whose profiles its owner may see. Best fit first. */
export async function findMatches(call, { exclude = [], limit = MATCHES_SHOWN } = {}) {
  if (!call.lookingFor?.length) return [];
  const terms = [...new Set(call.lookingFor.flatMap((r) => [r, ...wordsOf(r)]))].map(escapeRegex);
  const re = new RegExp(`(^|[\\s-])(${terms.join("|")})([\\s-]|$)`);
  const [candidates, blocked] = await Promise.all([
    User.find({ openToWork: true, suspendedAt: null, _id: { $nin: [call.owner, ...exclude] }, $or: [{ workOffers: re }, { tags: re }] })
      .select("username displayName avatarUrl csVerifiedByAdmin csVerifiedEarned workOffers tags workNote isPrivate")
      .limit(200),
    blockedUserIds(call.owner),
  ]);
  const found = [];
  for (const user of candidates) {
    if (blocked.has(String(user._id))) continue;
    const matched = matchedRoles(call.lookingFor, user);
    if (!matched.length) continue;
    if (user.isPrivate && !(await areFriends(call.owner, user._id))) continue;
    found.push({ user, matched });
  }
  found.sort((a, b) => b.matched.length - a.matched.length);
  return found.slice(0, limit);
}

/** The people who should be told about a new call: its best matches, less anyone who muted its owner. */
export async function peopleToTell(call) {
  const matches = await findMatches(call, { limit: MATCH_NOTICES * 2 });
  if (!matches.length) return [];
  const muting = new Set((await Mute.find({ user: { $in: matches.map((m) => m.user._id) }, muted: call.owner }).select("user").lean()).map((m) => String(m.user)));
  return matches.filter((m) => !muting.has(String(m.user._id))).slice(0, MATCH_NOTICES).map((m) => m.user._id);
}
