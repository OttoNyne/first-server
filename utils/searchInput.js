import { cleanLine } from "./profileFields.js";
import { escapeRegex } from "./regex.js";

export const MAX_SEARCH_WORDS = 5;
export const MAX_SEARCH_WORD = 40;
export const SEARCH_TYPES = ["people", "blog", "groups", "topics", "help"];
export const CONNECTIONS = ["any", "friends", "mutual"];

/**
 * What someone typed into the search box, as the words to look for: { words } or { error }. Hidden characters go, case is ignored,
 * repeated words count once, and there are at most five of them (each at most 40 characters), so a search can't be made to do
 * unbounded work. A search needs at least one word of two or more letters (one letter matches nearly everything).
 */
export function parseQuery(input) {
  if (typeof input !== "string") return { error: "Type something to search for" };
  if (input.length > 300) return { error: "That search is too long" };
  const text = cleanLine(input).toLowerCase();
  if (!text) return { error: "Type something to search for" };
  const words = [...new Set(text.split(" ").filter(Boolean))];
  if (words.length > MAX_SEARCH_WORDS) return { error: `Search for up to ${MAX_SEARCH_WORDS} words at a time` };
  if (words.some((w) => w.length > MAX_SEARCH_WORD)) return { error: `Words can be up to ${MAX_SEARCH_WORD} characters` };
  if (!words.some((w) => [...w].length >= 2)) return { error: "Type at least two letters" };
  return { words };
}

/** A Mongo filter: every word must appear (any case, as plain text and never as a pattern) in at least one of the fields. */
export function wordsFilter(words, fields) {
  return { $and: words.map((w) => ({ $or: fields.map((f) => ({ [f]: { $regex: escapeRegex(w), $options: "i" } })) })) };
}

/** Whether every word appears in the text. */
export const hasAllWords = (text, words) => {
  const lower = String(text ?? "").toLowerCase();
  return words.every((w) => lower.includes(w));
};

/** Whether any word appears in the text. */
export const hasAnyWord = (text, words) => {
  const lower = String(text ?? "").toLowerCase();
  return words.some((w) => lower.includes(w));
};

/** A short piece of the text around the first word found in it, on one line, for showing why something matched. */
export function snippetOf(text, words, max = 160) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const lower = flat.toLowerCase();
  const found = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, at - Math.floor(max / 4));
  let piece = flat.slice(start, start + max);
  if (start > 0) piece = "…" + piece.replace(/^\S*\s/, "");
  if (start + max < flat.length) piece = piece.replace(/\s\S*$/, "") + "…";
  return piece;
}
