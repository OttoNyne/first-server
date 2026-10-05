import { Router } from "express";
import { User } from "../models/User.js";
import { BlogEntry } from "../models/BlogEntry.js";
import { BlogComment } from "../models/BlogComment.js";
import { Group } from "../models/Group.js";
import { GroupMembership } from "../models/GroupMembership.js";
import { GroupTopic } from "../models/GroupTopic.js";
import { Task } from "../models/Task.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { blockedUserIds } from "../utils/visibility.js";
import { friendIdsOf, mutualCounts } from "../utils/friendGraph.js";
import { toPublicUser } from "../utils/serialize.js";
import { escapeRegex } from "../utils/regex.js";
import { isValidTag, normalizeTag } from "../utils/profileFields.js";
import { CONNECTIONS, SEARCH_TYPES, hasAllWords, hasAnyWord, parseQuery, snippetOf, wordsFilter } from "../utils/searchInput.js";
import { withMemberInfo } from "./groups.routes.js";

// Search across the site: people, blog entries, groups, group topics and Help wanted. Every kind follows the rules of the place it
// comes from (private profiles, blocks, suspended accounts, group membership), so searching can never show what browsing wouldn't.
export const searchRouter = Router();
searchRouter.use(requireAuth);

const PAGE = 20;
const MAX_PAGE = 5; // so at most 100 results of any search
const CANDIDATES = 200; // how many matches are looked through before ranking
const MAX_TIME_MS = 5000; // a search that takes longer than this is stopped
const searchLimiter = createLimiter({ name: "search", limit: 60, windowMs: 60 * 1000 });

const paged = (ranked, page) => ({ results: ranked.slice((page - 1) * PAGE, page * PAGE), page, hasMore: ranked.length > page * PAGE && page < MAX_PAGE });

// ---- People --------------------------------------------------------------------------------------------------------------
// Names and usernames always match. A person's bio and tags are profile content, so they only match for a public profile, a friend,
// or yourself: searching for "jazz" can never reveal that a private profile mentions it.
function personScore(user, words, isFriend) {
  const username = user.username.toLowerCase();
  const name = user.displayName.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (username === w) score += 100;
    else if (name === w) score += 90;
    else if (username.startsWith(w)) score += 60;
    else if (name.split(" ").some((part) => part.startsWith(w))) score += 50;
    else if (username.includes(w) || name.includes(w)) score += 30;
    else if ((user.tags ?? []).some((t) => t.includes(w))) score += 20;
    else score += 5; // the bio
  }
  return score + (isFriend ? 15 : 0);
}

async function searchPeople(me, words, { tag, connection }) {
  const [blocked, friends] = await Promise.all([blockedUserIds(me), friendIdsOf(me)]);
  const friendIds = [...friends];
  const readable = [{ isPrivate: { $ne: true } }, { _id: { $in: friendIds } }];
  const nameWord = (w) => ({ $or: [{ username: { $regex: escapeRegex(w), $options: "i" } }, { displayName: { $regex: escapeRegex(w), $options: "i" } }] });
  const anyWord = (w) => ({ $or: [nameWord(w), { $and: [{ $or: readable }, { $or: [{ tags: { $regex: escapeRegex(w), $options: "i" } }, { bio: { $regex: escapeRegex(w), $options: "i" } }] }] }] });
  const and = [{ suspendedAt: null }, { _id: { $nin: [...blocked, me] } }, ...words.map(anyWord)];
  if (tag) and.push({ tags: tag }, { $or: readable });
  if (connection === "friends") and.push({ _id: { $in: friendIds } });

  // the people whose name starts with a word are looked for on their own, so a common word can't push them out of the 200
  const starts = (w) => ({ $or: [{ username: { $regex: `^${escapeRegex(w)}`, $options: "i" } }, { displayName: { $regex: `^${escapeRegex(w)}`, $options: "i" } }] });
  const [first, rest] = await Promise.all([
    User.find({ $and: [...and, { $or: words.map(starts) }] }).limit(60).maxTimeMS(MAX_TIME_MS),
    User.find({ $and: and }).sort({ createdAt: -1, _id: -1 }).limit(CANDIDATES).maxTimeMS(MAX_TIME_MS),
  ]);
  const seen = new Set();
  const found = [...first, ...rest].filter((u) => !seen.has(String(u._id)) && seen.add(String(u._id)));

  const counts = await mutualCounts(me, found);
  const ranked = found
    .map((user) => ({ user, mutual: counts.get(String(user._id)) ?? 0, friend: friends.has(String(user._id)) }))
    .filter((r) => connection !== "mutual" || r.mutual > 0)
    .map((r) => ({ ...r, score: personScore(r.user, words, r.friend) + Math.min(r.mutual, 10) * 3 }))
    .sort((a, b) => b.score - a.score || b.mutual - a.mutual || a.user.username.localeCompare(b.user.username));
  return Promise.all(ranked.map(async (r) => ({ ...(await toPublicUser(r.user, me)), mutualCount: r.mutual, isFriend: r.friend })));
}

// ---- Blog entries ----------------------------------------------------------------------------------------------------------
async function searchBlog(me, words) {
  const [blocked, friends] = await Promise.all([blockedUserIds(me), friendIdsOf(me)]);
  const found = await BlogEntry.find({ author: { $nin: [...blocked] }, ...wordsFilter(words, ["title", "body"]) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(CANDIDATES)
    .maxTimeMS(MAX_TIME_MS)
    .populate("author");
  // the same gate as reading the entry: a suspended author's entries are gone, a private author's are for friends (and themselves)
  const readable = found.filter((e) => e.author && (String(e.author._id) === String(me) || (!e.author.suspendedAt && (!e.author.isPrivate || friends.has(String(e.author._id))))));
  const counts = new Map((await BlogComment.aggregate([{ $match: { entry: { $in: readable.map((e) => e._id) } } }, { $group: { _id: "$entry", n: { $sum: 1 } } }])).map((c) => [String(c._id), c.n]));
  return Promise.all(
    readable
      .map((e) => ({ e, inTitle: hasAllWords(e.title, words) }))
      .sort((a, b) => Number(b.inTitle) - Number(a.inTitle)) // the sort is stable, so each group stays newest first
      .map(async ({ e }) => ({ id: e._id, title: e.title, snippet: snippetOf(e.body, words), createdAt: e.createdAt, commentCount: counts.get(String(e._id)) ?? 0, author: await toPublicUser(e.author, me) }))
  );
}

// ---- Groups ----------------------------------------------------------------------------------------------------------------
async function searchGroups(me, words) {
  const found = await Group.find(wordsFilter(words, ["name", "description"])).sort({ createdAt: -1, _id: -1 }).limit(CANDIDATES).maxTimeMS(MAX_TIME_MS);
  const withInfo = await withMemberInfo(found, me);
  return withInfo
    .map((g) => ({ ...g, snippet: hasAnyWord(g.name, words) ? "" : snippetOf(g.description, words), inName: hasAllWords(g.name, words) }))
    .sort((a, b) => Number(b.inName) - Number(a.inName) || b.memberCount - a.memberCount)
    .map(({ inName, ...g }) => g);
}

// ---- Group topics (only in the groups you have joined, like their boards) ---------------------------------------------------
async function searchTopics(me, words) {
  const [memberships, blocked] = await Promise.all([GroupMembership.find({ user: me }).select("group").limit(500), blockedUserIds(me)]);
  const groupIds = memberships.map((m) => m.group);
  if (!groupIds.length) return [];
  const found = await GroupTopic.find({ group: { $in: groupIds }, author: { $nin: [...blocked] }, ...wordsFilter(words, ["title", "body"]) })
    .sort({ lastActivityAt: -1, _id: -1 })
    .limit(CANDIDATES)
    .maxTimeMS(MAX_TIME_MS);
  const [groups, authors] = await Promise.all([Group.find({ _id: { $in: [...new Set(found.map((t) => String(t.group)))] } }), User.find({ _id: { $in: [...new Set(found.map((t) => String(t.author)))] } })]);
  const groupName = new Map(groups.map((g) => [String(g._id), g.name]));
  const byId = new Map(authors.map((u) => [String(u._id), u]));
  return Promise.all(
    found
      .map((t) => ({ t, inTitle: hasAllWords(t.title, words) }))
      .sort((a, b) => Number(b.inTitle) - Number(a.inTitle))
      .map(async ({ t }) => ({
        id: t._id,
        groupId: t.group,
        groupName: groupName.get(String(t.group)) ?? "",
        title: t.title,
        snippet: snippetOf(t.body, words),
        replyCount: t.replyCount,
        lastActivityAt: t.lastActivityAt,
        author: byId.has(String(t.author)) ? await toPublicUser(byId.get(String(t.author)), me) : null,
      }))
  );
}

// ---- Help wanted -----------------------------------------------------------------------------------------------------------
async function searchHelp(me, words) {
  const [blocked, friends] = await Promise.all([blockedUserIds(me), friendIdsOf(me)]);
  const found = await Task.find({ isPublic: true, done: false, owner: { $nin: [...blocked, me] }, ...wordsFilter(words, ["title", "description"]) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(CANDIDATES)
    .maxTimeMS(MAX_TIME_MS)
    .populate("owner");
  // as on the board: a private profile's requests are for its friends, and a suspended person's aren't shown
  const readable = found.filter((t) => t.owner && !t.owner.suspendedAt && (!t.owner.isPrivate || friends.has(String(t.owner._id))));
  return Promise.all(
    readable
      .map((t) => ({ t, inTitle: hasAllWords(t.title, words) }))
      .sort((a, b) => Number(b.inTitle) - Number(a.inTitle))
      .map(async ({ t }) => ({ id: t._id, title: t.title, snippet: snippetOf(t.description, words), priority: t.priority, dueDate: t.dueDate, createdAt: t.createdAt, author: await toPublicUser(t.owner, me) }))
  );
}

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/search?q=jazz poster&type=people|blog|groups|topics|help&tag=&connection=any|friends|mutual&page=
searchRouter.get("/", async (req, res) => {
  const type = req.query.type === undefined ? "people" : req.query.type;
  if (!SEARCH_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${SEARCH_TYPES.join(", ")}` });
  const parsed = parseQuery(req.query.q);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const options = { tag: "", connection: "any" };
  if (req.query.tag !== undefined && req.query.tag !== "") {
    const tag = normalizeTag(typeof req.query.tag === "string" ? req.query.tag : "");
    if (type !== "people") return res.status(400).json({ error: "Only people can be filtered by tag" });
    if (!isValidTag(tag)) return res.status(400).json({ error: "That isn't a valid tag" });
    options.tag = tag;
  }
  if (req.query.connection !== undefined && req.query.connection !== "") {
    if (!CONNECTIONS.includes(req.query.connection)) return res.status(400).json({ error: `connection must be one of: ${CONNECTIONS.join(", ")}` });
    if (type !== "people") return res.status(400).json({ error: "Only people can be filtered by connection" });
    options.connection = req.query.connection;
  }
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(req.query.page, 10) || 1));

  if (!(await searchLimiter.allow(req.user.id))) return res.status(429).json({ error: "You're searching very quickly. Wait a moment and try again." });

  try {
    const { words } = parsed;
    const ranked = await { people: () => searchPeople(req.user.id, words, options), blog: () => searchBlog(req.user.id, words), groups: () => searchGroups(req.user.id, words), topics: () => searchTopics(req.user.id, words), help: () => searchHelp(req.user.id, words) }[type]();
    res.json({ type, words, ...paged(ranked, page) });
  } catch (err) {
    if (err?.codeName === "MaxTimeMSExpired") return res.status(503).json({ error: "That search took too long. Try fewer or more specific words." });
    throw err;
  }
});
