// "Online now" and "last active": shown only to a person's accepted friends, only if they haven't turned it off, and only as a
// rough bucket, never as an exact time (so it can't be used to learn when someone sleeps or goes out).

export const ONLINE_MS = 5 * 60 * 1000;
export const TODAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A person's page checks in about every two minutes; a check-in closer than this to the last one isn't written.
export const PING_EVERY_MS = 60 * 1000;

/** "online" (within 5 minutes), "today", "week", or null when it is longer ago, unknown, or the person has turned it off. */
export function activityBucket(user, now = Date.now()) {
  if (!user || user.showActivity === false || !user.lastActiveAt) return null;
  const ago = now - new Date(user.lastActiveAt).getTime();
  if (ago < 0 || ago < ONLINE_MS) return "online";
  if (ago < TODAY_MS) return "today";
  if (ago < WEEK_MS) return "week";
  return null;
}

/** What to add to a user's public shape for this viewer: `{ activity }` for a friend (when there is something to show), otherwise nothing. */
export function activityFor(user, viewerId, isFriend) {
  if (!isFriend || !viewerId || String(user._id) === String(viewerId)) return {};
  const activity = activityBucket(user);
  return activity ? { activity } : {};
}
