// @mentions: naming someone in what you write, as @username. The text stays plain text; this finds the names in it.

/** The most people one piece of writing can name (and so notify). */
export const MAX_MENTIONS = 5;

// An @ that starts a word (not in the middle of an email address, a longer name or a run of @s), then a username.
const MENTION = /(?<![\w@])@([A-Za-z0-9_]{3,30})(?![\w@])/g;

/** The usernames named in some text, lower-cased, each once, in order, at most MAX_MENTIONS of them. */
export function mentionsIn(text) {
  if (typeof text !== "string" || !text.includes("@")) return [];
  const names = [];
  for (const match of text.matchAll(MENTION)) {
    const name = match[1].toLowerCase();
    if (!names.includes(name)) names.push(name);
    if (names.length >= MAX_MENTIONS) break;
  }
  return names;
}

/** Where a notification takes you must be an address inside the site: one slash at the start, nothing that could mean another site. */
export const isSitePath = (path) => typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && path.length <= 300;
