import { Mute } from "../models/Mute.js";
import { cleanLine } from "./profileFields.js";
import { escapeRegex } from "./regex.js";

export const MAX_MUTED_PEOPLE = 500;
export const MAX_MUTED_WORDS = 30;
export const MAX_MUTED_WORD = 40;

/** The ids (as strings) of the people this person has muted. */
export async function mutedUserIds(userId) {
  if (!userId) return new Set();
  const rows = await Mute.find({ user: userId }).select("muted").lean();
  return new Set(rows.map((r) => String(r.muted)));
}

/** The words and phrases someone asks to hear nothing about: one line each, up to 40 characters, lower-cased, no repeats, at most 30. Returns { value } or { error }. */
export function readWords(list) {
  if (!Array.isArray(list)) return { error: "Muted words must be a list" };
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") return { error: "Muted words must be text" };
    const word = cleanLine(raw).toLocaleLowerCase();
    if (!word) continue;
    if ([...word].length > MAX_MUTED_WORD) return { error: `A muted word can be up to ${MAX_MUTED_WORD} characters` };
    seen.add(word);
  }
  if (seen.size > MAX_MUTED_WORDS) return { error: `You can mute up to ${MAX_MUTED_WORDS} words or phrases` };
  return { value: [...seen] };
}

/**
 * A test for text that contains any of these words, as whole words in any capitals ("art" is found in "my art" but not in "start"; a phrase
 * is found as it is written; "#spoilers" matches that tag). Null when there are no words.
 */
export function wordMatcher(words) {
  const list = (words ?? []).filter((w) => typeof w === "string" && w.trim());
  if (list.length === 0) return null;
  const edge = "[\\p{L}\\p{N}_]";
  const re = new RegExp(`(?<!${edge})(?:${list.map(escapeRegex).join("|")})(?!${edge})`, "iu");
  return (text) => typeof text === "string" && re.test(text);
}

/** Whether a post is hidden by these words: its own words, the options of its poll, and the words of a post it shares. */
export function postHidden(post, matches) {
  if (!matches) return false;
  return matches(post.content) || (post.poll?.options ?? []).some(matches) || matches(post.repostOf?.content);
}

/** Whether a portfolio piece is hidden by these words (its caption). */
export const pieceHidden = (item, matches) => Boolean(matches && matches(item.caption));
