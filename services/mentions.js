import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { GroupMembership } from "../models/GroupMembership.js";
import { areBlocked, areFriends, assertVisible } from "../utils/visibility.js";
import { MAX_MENTIONS, isSitePath, mentionsIn } from "../utils/mentions.js";
import { createLimiter } from "../utils/rateLimit.js";

// Telling people they were named in something someone wrote (@username). The writing is saved first and this runs after it: it never
// stops a post or a comment from being made. A person is only told if they could actually see what was written, so naming someone is
// never a way to show them something they couldn't otherwise open, or to reach someone who has blocked you.
const limiter = createLimiter({ name: "mention", limit: 60, windowMs: 60 * 60 * 1000 });

/** For writing that sits on someone's profile (their posts, comments on them, their blog): whoever may open that profile may be told. */
export const canSeeProfileOf = (owner) => async (user) => {
  try {
    await assertVisible(owner, user._id);
    return true;
  } catch {
    return false;
  }
};

/** For writing meant for a person's friends (bulletins): the friends, and the author. */
export const canSeeAsFriendOf = (authorId) => async (user) => String(user._id) === String(authorId) || areFriends(authorId, user._id);

/** For writing inside a group: its members. */
export const canSeeInGroup = (groupId) => async (user) => Boolean(await GroupMembership.exists({ group: groupId, user: user._id }));

/**
 * Tell the people named in `text` (and not in `before`, the text it replaces when this is an edit, so an edit tells only about new names).
 * `url` is where the notification takes them, an address inside the site; `canSee` decides whether a named person may see the writing;
 * `skip` holds people who are already being told about this some other way. Returns the usernames that were told.
 */
export async function notifyMentions({ text, before = "", actorId, url, canSee, skip = [] }) {
  try {
    if (!isSitePath(url)) return [];
    const already = new Set(mentionsIn(before));
    const names = mentionsIn(text).filter((name) => !already.has(name));
    if (!names.length) return [];
    const skipped = new Set(skip.map(String));
    skipped.add(String(actorId));
    const users = await User.find({ username: { $in: names }, suspendedAt: null }).select("_id username");
    const told = [];
    for (const user of users.slice(0, MAX_MENTIONS)) {
      if (skipped.has(String(user._id))) continue;
      if (await areBlocked(actorId, user._id)) continue;
      if (!(await canSee(user))) continue;
      if (!(await limiter.allow(actorId))) break;
      await Notification.create({ recipient: user._id, type: "mention", payload: { actorId: String(actorId), url } });
      told.push(user.username);
    }
    return told;
  } catch (err) {
    console.error("Couldn't notify of a mention:", err.message);
    return [];
  }
}
