import { Router } from "express";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { TopFriend } from "../models/TopFriend.js";
import { ProfileComment } from "../models/ProfileComment.js";
import { Track } from "../models/Track.js";
import { Notification } from "../models/Notification.js";
import { requireAuth, attachUserIfPresent, clearAuthCookie, setAuthCookie, signAuthToken } from "../middleware/auth.js";
import { Friendship } from "../models/Friendship.js";
import { UsernameHistory } from "../models/UsernameHistory.js";
import { usernameSchema, displayNameSchema } from "../utils/username.js";
import { createLimiter } from "../utils/rateLimit.js";
import { deleteAccount } from "../services/accountDeletion.js";
import { buildExport } from "../services/dataExport.js";
import { WALLPAPER_MOTIONS, isWallpaperMotion } from "../utils/wallpaperMotion.js";
import { MAX_LISTENING, MAX_MOOD, MAX_WORK_NOTE, checkLine, checkOffers, checkTags, isValidTag, normalizeTag } from "../utils/profileFields.js";
import { checkHidden, checkOrder } from "../utils/profileSections.js";
import { areFriends, blockedUserIds, getProfileForViewer } from "../utils/visibility.js";
import { canSeeProfileOf, notifyMentions } from "../services/mentions.js";
import { activityFor } from "../utils/activity.js";
import { ProfileView } from "../models/ProfileView.js";
import { MAX_COMMENT, allowEdit, checkText, cursorFilter } from "../utils/textInput.js";
import { deleteStoredAssetIfUnused } from "../services/storedAssets.js";
import { toPublicUser, toPublicTrack, toPublicComment } from "../utils/serialize.js";
import { checkComment } from "../utils/commentInput.js";
import { releasePictures } from "../services/commentPictures.js";
import { escapeRegex } from "../utils/regex.js";
import { applyThemeChange, checkTheme } from "../utils/profileStyle.js";
import { isLanguage, LANGUAGES } from "../utils/languages.js";

export const profilesRouter = Router();

profilesRouter.get("/", requireAuth, async (req, res) => {
  const search = req.query.search;
  if (!search) return res.json({ users: [] });
  const pattern = escapeRegex(search);
  const users = await User.find({
    suspendedAt: null,
    _id: { $nin: [...(await blockedUserIds(req.user.id))] },
    $or: [{ username: { $regex: pattern, $options: "i" } }, { displayName: { $regex: pattern, $options: "i" } }],
  }).limit(20);
  res.json({ users: await Promise.all(users.map((u) => toPublicUser(u, req.user.id))) });
});

// ---- Discover: browse creatives by what they do ---------------------------------------------------------------------
const DISCOVER_PAGE = 20;
const MAX_DISCOVER_PAGE = 50;

// New creatives, newest first, optionally only those with a tag. Private profiles are never listed (their tags are as
// private as the rest of them), and nobody who has blocked you, or whom you have blocked, appears.
profilesRouter.get("/discover", requireAuth, async (req, res) => {
  const filter = { isPrivate: { $ne: true }, suspendedAt: null, _id: { $nin: [...(await blockedUserIds(req.user.id)), req.user.id] } };
  if (req.query.tag !== undefined) {
    const tag = normalizeTag(typeof req.query.tag === "string" ? req.query.tag : "");
    if (!isValidTag(tag)) return res.status(400).json({ error: "That isn't a valid tag" });
    filter.tags = tag;
  }
  const page = Math.min(MAX_DISCOVER_PAGE, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const found = await User.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * DISCOVER_PAGE)
    .limit(DISCOVER_PAGE + 1);
  const users = found.slice(0, DISCOVER_PAGE);
  res.json({ users: await Promise.all(users.map((u) => toPublicUser(u, req.user.id))), page, hasMore: found.length > DISCOVER_PAGE && page < MAX_DISCOVER_PAGE });
});

// The tags people use, most used first (public profiles only); `q` narrows them to those starting with it, for suggestions.
profilesRouter.get("/tags", requireAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? normalizeTag(req.query.q) : "";
  const match = { isPrivate: { $ne: true }, suspendedAt: null, "tags.0": { $exists: true } };
  const pipeline = [{ $match: match }, { $unwind: "$tags" }];
  if (q) pipeline.push({ $match: { tags: { $regex: `^${escapeRegex(q)}` } } });
  pipeline.push({ $group: { _id: "$tags", count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 24 });
  const rows = await User.aggregate(pipeline);
  res.json({ tags: rows.map((r) => ({ tag: r._id, count: r.count })) });
});

profilesRouter.patch("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);
  const { displayName, bio, avatarUrl, wallpaperUrl, wallpaperType, wallpaperPosition, wallpaperMotion, isPrivate, theme, mood, listeningTo, tags, sectionOrder, hiddenSections, showActivity, chatStatus, profileViews, showConnections, language, openToWork, workOffers, workNote, listInSearchEngines } = req.body;
  const fields = {};
  // the theme is checked before anything is changed, so a bad setting leaves the profile exactly as it was
  const themeChange = theme !== undefined ? checkTheme(theme) : null;
  if (themeChange?.error) return res.status(400).json({ error: themeChange.error });
  for (const [name, value, max, label] of [["mood", mood, MAX_MOOD, "Mood"], ["listeningTo", listeningTo, MAX_LISTENING, "Listening to"]]) {
    if (value === undefined) continue;
    const checked = checkLine(value, max, label);
    if (checked.error) return res.status(400).json({ error: checked.error });
    fields[name] = checked.value;
  }
  if (tags !== undefined) {
    const checked = checkTags(tags);
    if (checked.error) return res.status(400).json({ error: checked.error });
    fields.tags = checked.value;
  }
  for (const [name, value, check] of [["sectionOrder", sectionOrder, checkOrder], ["hiddenSections", hiddenSections, checkHidden]]) {
    if (value === undefined) continue;
    const checked = check(value);
    if (checked.error) return res.status(400).json({ error: checked.error });
    fields[name] = checked.value;
  }
  if (showActivity !== undefined) {
    if (typeof showActivity !== "boolean") return res.status(400).json({ error: "showActivity must be true or false" });
    fields.showActivity = showActivity;
    // turning it off also forgets when they were last active
    if (!showActivity) fields.lastActiveAt = null;
  }
  if (listInSearchEngines !== undefined) {
    if (typeof listInSearchEngines !== "boolean") return res.status(400).json({ error: "listInSearchEngines must be true or false" });
    fields.listInSearchEngines = listInSearchEngines;
  }
  if (openToWork !== undefined) {
    if (typeof openToWork !== "boolean") return res.status(400).json({ error: "openToWork must be true or false" });
    fields.openToWork = openToWork;
  }
  if (workOffers !== undefined) {
    const offers = checkOffers(workOffers);
    if (offers.error) return res.status(400).json({ error: offers.error });
    fields.workOffers = offers.value;
  }
  if (workNote !== undefined) {
    const note = checkLine(workNote, MAX_WORK_NOTE, "The note");
    if (note.error) return res.status(400).json({ error: note.error });
    fields.workNote = note.value;
  }
  if (language !== undefined) {
    if (!isLanguage(language)) return res.status(400).json({ error: `language must be one of: ${LANGUAGES.join(", ")}` });
    fields.language = language;
  }
  if (chatStatus !== undefined) {
    if (typeof chatStatus !== "boolean") return res.status(400).json({ error: "chatStatus must be true or false" });
    fields.chatStatus = chatStatus;
  }
  if (showConnections !== undefined) {
    if (typeof showConnections !== "boolean") return res.status(400).json({ error: "showConnections must be true or false" });
    fields.showConnections = showConnections;
  }
  if (profileViews !== undefined) {
    if (typeof profileViews !== "boolean") return res.status(400).json({ error: "profileViews must be true or false" });
    fields.profileViews = profileViews;
  }
  if (displayName !== undefined) {
    const parsedName = displayNameSchema.safeParse(displayName);
    if (!parsedName.success) return res.status(400).json({ error: parsedName.error.issues[0].message });
    req.body.displayName = parsedName.data;
  }
  if (bio !== undefined && bio !== null && (typeof bio !== "string" || bio.length > 1000)) {
    return res.status(400).json({ error: "Bio must be text of 1000 characters or fewer" });
  }
  if (wallpaperMotion !== undefined && !isWallpaperMotion(wallpaperMotion)) {
    return res.status(400).json({ error: `wallpaperMotion must be one of: ${WALLPAPER_MOTIONS.join(", ")}` });
  }
  const replaced = [];

  if (displayName !== undefined) user.displayName = req.body.displayName;
  if (bio !== undefined) user.bio = bio;
  if (avatarUrl !== undefined) {
    if (user.avatarUrl && user.avatarUrl !== avatarUrl) replaced.push(user.avatarUrl);
    user.avatarUrl = avatarUrl;
  }
  if (wallpaperUrl !== undefined) {
    if (user.wallpaperUrl && user.wallpaperUrl !== wallpaperUrl) replaced.push(user.wallpaperUrl);
    user.wallpaperUrl = wallpaperUrl;
  }
  if (wallpaperType !== undefined) user.wallpaperType = wallpaperType;
  if (wallpaperPosition !== undefined) user.wallpaperPosition = wallpaperPosition;
  if (wallpaperMotion !== undefined) user.wallpaperMotion = wallpaperMotion;
  Object.assign(user, fields);
  if (isPrivate !== undefined) user.isPrivate = isPrivate;
  if (theme !== undefined) user.theme = applyThemeChange(user.theme?.toObject?.() ?? user.theme, themeChange.value);

  await user.save();
  // turning profile views off forgets every visit: the ones to your profile and the ones you made to other people's
  if (fields.profileViews === false) await ProfileView.deleteMany({ $or: [{ owner: user._id }, { viewer: user._id }] });
  // A replaced avatar/wallpaper we stored (an upload or an AI image) would
  // otherwise stay on Cloudinary forever.
  for (const oldUrl of replaced) await deleteStoredAssetIfUnused({ ownerId: user._id, url: oldUrl });
  res.json({ user: await toPublicUser(user, req.user.id) });
});

// Self-service account deletion. Requires the current password (a stolen
// session alone can't destroy an account) and is throttled like login.
const deleteAttempts = createLimiter({ name: "delete-account", limit: 5, windowMs: 15 * 60 * 1000 });

profilesRouter.delete("/me", requireAuth, async (req, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Enter your password to delete your account" });
  }
  if (await deleteAttempts.isLimited(req.user.id)) {
    return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
  }
  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (!(await user.comparePassword(password))) {
    await deleteAttempts.hit(req.user.id);
    return res.status(403).json({ error: "Incorrect password" });
  }

  await deleteAccount(user._id);
  clearAuthCookie(res);
  res.status(204).end();
});

// "Download my data": everything the person has written or chosen, as one JSON file (see services/dataExport.js for exactly what is and
// isn't in it). It holds private things (messages they sent, their email), so, like deleting the account, it asks for the password again
// (a stolen session alone can't take it), counts wrong passwords, and is limited so it can't be used to keep the server busy.
const exportPasswordFails = createLimiter({ name: "export-password", limit: 5, windowMs: 15 * 60 * 1000 });
const exportsPerHour = createLimiter({ name: "export-data", limit: 3, windowMs: 60 * 60 * 1000 });

profilesRouter.post("/me/export", requireAuth, async (req, res) => {
  try {
    const { password } = req.body ?? {};
    if (typeof password !== "string" || !password || password.length > 200) {
      return res.status(400).json({ error: "Enter your password to download your data" });
    }
    if (await exportPasswordFails.isLimited(req.user.id)) {
      res.set("Retry-After", String(exportPasswordFails.windowSeconds));
      return res.status(429).json({ error: "Too many attempts — please wait a few minutes and try again" });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (!(await user.comparePassword(password))) {
      await exportPasswordFails.hit(req.user.id);
      return res.status(403).json({ error: "Incorrect password" });
    }
    if (!(await exportsPerHour.allow(req.user.id))) {
      res.set("Retry-After", String(exportsPerHour.windowSeconds));
      return res.status(429).json({ error: "You've already downloaded your data a few times this hour — please try again later." });
    }
    const data = await buildExport(user._id);
    const day = new Date().toISOString().slice(0, 10);
    res.set({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="creativesselect-${user.username}-${day}.json"`,
      // personal data: never kept by a browser cache or anything in between
      "Cache-Control": "no-store",
    });
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function topFriendsFor(ownerId, viewerId) {
  const rows = await TopFriend.find({ owner: ownerId }).sort("position").populate("target");
  return Promise.all(rows.filter((tf) => tf.target).map((tf) => toPublicUser(tf.target, viewerId)));
}

profilesRouter.put("/me/top-friends", requireAuth, async (req, res) => {
  // req.body.usernames must be an array of strings — a string or number here
  // still has .slice() (or neither), so an unvalidated non-array shape
  // reaches .map() below and crashes instead of just being treated as empty.
  const rawUsernames = Array.isArray(req.body.usernames) ? req.body.usernames : [];
  const usernames = rawUsernames.filter((u) => typeof u === "string").slice(0, 8);
  const users = await User.find({ username: { $in: usernames } });
  const byUsername = new Map(users.map((u) => [u.username, u]));

  // Only accepted friends can be top friends.
  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: req.user.id }, { addressee: req.user.id }],
  });
  const friendIds = new Set(friendships.map((fr) => (String(fr.requester) === req.user.id ? String(fr.addressee) : String(fr.requester))));

  await TopFriend.deleteMany({ owner: req.user.id });
  // Dedupe by resolved target id, not the raw username string — the unique
  // (owner, target) index means the same friend picked twice (a repeated
  // or case-variant username) would otherwise crash insertMany with a
  // duplicate-key error. Re-index position contiguously over what's kept.
  const seenTargets = new Set();
  const docs = [];
  for (const username of usernames) {
    const target = byUsername.get(username);
    if (!target || !friendIds.has(String(target._id)) || seenTargets.has(String(target._id))) continue;
    seenTargets.add(String(target._id));
    docs.push({ owner: req.user.id, target: target._id, position: docs.length });
  }
  if (docs.length) await TopFriend.insertMany(docs);

  res.json({ topFriends: await topFriendsFor(req.user.id, req.user.id) });
});

// Change your username. Usernames are public URLs, so: URL-safe characters only,
// unique (case-insensitively), limited to 3 changes a day, and the name you give up
// stays reserved for you for 30 days so nobody can instantly take it over.
const usernameChanges = createLimiter({ name: "username-change", limit: 3, windowMs: 24 * 60 * 60 * 1000 });

profilesRouter.put("/me/username", requireAuth, async (req, res) => {
  const parsed = usernameSchema.safeParse(req.body?.username);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const wanted = parsed.data.toLowerCase();

  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (wanted === user.username) return res.json({ user: await toPublicUser(user, req.user.id) });

  if (await usernameChanges.isLimited(req.user.id)) {
    return res.status(429).json({ error: "You can change your username 3 times a day — try again tomorrow" });
  }
  if (await User.exists({ username: wanted })) {
    return res.status(409).json({ error: "That username is already taken" });
  }
  const reserved = await UsernameHistory.findOne({ username: wanted, user: { $ne: user._id } });
  if (reserved) {
    return res.status(409).json({ error: "That username was recently used by someone else and isn't available yet" });
  }

  const previous = user.username;
  user.username = wanted;
  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "That username is already taken" });
    throw err;
  }
  await usernameChanges.hit(req.user.id);
  await UsernameHistory.create({ username: previous, user: user._id, expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
  // The session token carries the username; re-issue it so it's current.
  setAuthCookie(res, signAuthToken(user, req.user.sid));
  res.json({ user: await toPublicUser(user, req.user.id) });
});

profilesRouter.delete("/comments/:commentId", requireAuth, async (req, res) => {
  const comment = await ProfileComment.findById(req.params.commentId);
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  const isAuthor = String(comment.author) === req.user.id;
  const isOwner = String(comment.profileOwner) === req.user.id;
  if (!isAuthor && !isOwner) return res.status(403).json({ error: "Not allowed" });
  await comment.deleteOne();
  await releasePictures([comment]);
  res.status(204).end();
});

profilesRouter.get("/:username", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const isFriend = req.user ? await areFriends(req.user.id, user._id) : false;
    res.json({ user: { ...(await toPublicUser(user, req.user?.id)), ...activityFor(user, req.user?.id, isFriend) } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

profilesRouter.get("/:username/top-friends", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    res.json({ topFriends: await topFriendsFor(user._id, req.user?.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

profilesRouter.get("/:username/comments", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    // Newest first, twenty at a time; ?before=<comment id> asks for the ones older than that.
    const filter = { profileOwner: user._id };
    const before = cursorFilter(req.query, mongoose);
    if (before) filter._id = { $lt: before };
    const found = await ProfileComment.find(filter).sort({ _id: -1 }).limit(21).populate("author");
    const comments = found.slice(0, 20);
    res.json({ comments: await Promise.all(comments.map((c) => toPublicComment(c, req.user?.id))), hasMore: found.length > 20 });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

const guestbookLimiter = createLimiter({ name: "guestbook-create", limit: 20, windowMs: 10 * 60 * 1000 });

// Change a testimonial you wrote (the profile's owner can delete it, but only its author can change what it says).
profilesRouter.patch("/comments/:commentId", requireAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.commentId)) return res.status(404).json({ error: "Comment not found" });
  const comment = await ProfileComment.findById(req.params.commentId);
  if (!comment || String(comment.author) !== req.user.id) return res.status(404).json({ error: "Comment not found" });
  const text = await checkComment(req.body, { userId: req.user.id, max: MAX_COMMENT, label: "Testimonials", current: comment });
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await allowEdit(req, res))) return;
  const beforeText = comment.content;
  const takenOff = text.value.imageUrl === null && comment.imageUrl ? comment.imageUrl : null;
  if ((text.value.content !== undefined && text.value.content !== comment.content) || takenOff) {
    if (text.value.content !== undefined) comment.content = text.value.content;
    if (takenOff) comment.imageUrl = null;
    comment.editedAt = new Date();
    await comment.save();
    if (takenOff) await releasePictures([{ author: comment.author, imageUrl: takenOff }]);
  }
  await comment.populate("author");
  const wroteOn = await User.findById(comment.profileOwner);
  if (wroteOn) await notifyMentions({ text: comment.content, before: beforeText, actorId: req.user.id, url: `/u/${wroteOn.username}#testimonials`, canSee: canSeeProfileOf(wroteOn) });
  res.json({ comment: await toPublicComment(comment, req.user.id) });
});

profilesRouter.post("/:username/comments", requireAuth, async (req, res) => {
  let owner;
  try {
    owner = await getProfileForViewer(req.params.username, req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  const text = await checkComment(req.body, { userId: req.user.id, max: MAX_COMMENT, label: "Testimonials" });
  if (text.error) return res.status(400).json({ error: text.error });
  if (!(await guestbookLimiter.allow(req.user.id))) {
    res.set("Retry-After", String(guestbookLimiter.windowSeconds));
    return res.status(429).json({ error: "You're writing testimonials too fast — try again in a few minutes." });
  }
  let comment = await ProfileComment.create({
    profileOwner: owner._id,
    author: req.user.id,
    content: text.value.content,
    imageUrl: text.value.imageUrl ?? null,
  });
  comment = await comment.populate("author");
  if (String(owner._id) !== req.user.id) {
    await Notification.create({
      recipient: owner._id,
      type: "profile_comment",
      payload: { commentId: comment._id, actorId: req.user.id },
    });
  }
  await notifyMentions({ text: comment.content, actorId: req.user.id, url: `/u/${owner.username}#testimonials`, canSee: canSeeProfileOf(owner), skip: [owner._id] });
  res.status(201).json({ comment: await toPublicComment(comment, req.user.id) });
});

profilesRouter.get("/:username/tracks", attachUserIfPresent, async (req, res) => {
  try {
    const user = await getProfileForViewer(req.params.username, req.user?.id);
    const tracks = await Track.find({ owner: user._id }).sort("position");
    res.json({ tracks: tracks.map(toPublicTrack) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
