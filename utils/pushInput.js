// What push notifications are made of: which kinds of notification a person can switch on and off, and what a device may tell us.

/** The switches a person has, and the notification types each one covers. */
export const PUSH_CATEGORIES = {
  messages: ["message"],
  friends: ["friend_request", "friend_accept", "invite_joined", "group_invite", "friend_birthday"],
  comments: ["comment", "profile_comment", "media_comment", "blog_comment", "reaction"],
  events: ["event_created", "event_updated", "event_cancelled", "event_reminder", "live_scheduled", "live_reminder"],
  live: ["live_started"],
  updates: ["blog_post", "help_offer", "help_accepted", "report_resolved", "content_removed", "cs_verified"],
};
export const CATEGORY_NAMES = Object.keys(PUSH_CATEGORIES);

const CATEGORY_OF = new Map(Object.entries(PUSH_CATEGORIES).flatMap(([name, types]) => types.map((type) => [type, name])));
/** Which switch a notification type belongs to (null for a type no switch covers, which is never pushed). */
export const categoryOf = (type) => CATEGORY_OF.get(type) ?? null;

// The server sends each push to the address the device gave it, so that address must be a real push service and nothing else: otherwise a
// device could name any web address and have this server send requests to it. These are the services browsers use (Chrome, Edge and
// other Chromium browsers; Firefox; Safari and iPhones; Windows).
const EXACT_HOSTS = new Set(["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];
export function isPushServiceHost(hostname) {
  const host = String(hostname).toLowerCase();
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A subscription as a browser gives it ({ endpoint, keys: { p256dh, auth } }): { value: { endpoint, p256dh, auth } } or { error }. */
export function checkSubscription(input) {
  const bad = { error: "That isn't a notification subscription this site can use" };
  const endpoint = input?.endpoint;
  const p256dh = input?.keys?.p256dh;
  const auth = input?.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return bad;
  if (endpoint.length > 700 || p256dh.length > 200 || auth.length > 50) return bad;
  if (!BASE64URL.test(p256dh) || !BASE64URL.test(auth) || p256dh.length < 20 || auth.length < 8) return bad;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return bad;
  }
  // https to a push service's own address on the usual port, with no name or password in it
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !isPushServiceHost(url.hostname)) return bad;
  return { value: { endpoint: url.toString(), p256dh, auth } };
}

/** Changes to the switches, from a request: { value: { messages: true, ... } } (only the ones sent) or { error }. */
export function checkPrefs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Say which notifications to turn on or off" };
  const keys = Object.keys(input);
  if (!keys.length) return { error: "Say which notifications to turn on or off" };
  const value = {};
  for (const key of keys) {
    if (!CATEGORY_NAMES.includes(key)) return { error: `Unknown kind of notification: ${key.slice(0, 30)}` };
    if (typeof input[key] !== "boolean") return { error: `${key} must be true or false` };
    value[key] = input[key];
  }
  return { value };
}
