import { cleanLine } from "./profileFields.js";

export const MAX_BLOG_TITLE = 120;
export const MAX_BLOG_BODY = 10000;

// Control and zero-width characters go, but line breaks stay: they are how paragraphs are written.
const UNPRINTABLE = new RegExp("[" + [[0, 8], [11, 12], [14, 31], [127, 159], [8203, 8207], [8232, 8238], [8288, 8303], [65279, 65279]].map(([from, to]) => String.fromCodePoint(from) + "-" + String.fromCodePoint(to)).join("") + "]", "g");

/** An entry's text as stored: no hidden characters, tidy line breaks, at most one blank line in a row, no space at either end of a line. */
export function cleanBody(value) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(UNPRINTABLE, "")
    .replace(/\t/g, " ")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A title and body for an entry: returns { title, body } or { error }. Pass `partial` to allow leaving either one out (an edit). */
export function checkEntry(input, { partial = false } = {}) {
  const out = {};
  if (input?.title !== undefined || !partial) {
    if (typeof input?.title !== "string") return { error: "Give your entry a title" };
    const title = cleanLine(input.title);
    if (!title) return { error: "Give your entry a title" };
    if (title.length > MAX_BLOG_TITLE) return { error: `Titles can be up to ${MAX_BLOG_TITLE} characters` };
    out.title = title;
  }
  if (input?.body !== undefined || !partial) {
    if (typeof input?.body !== "string") return { error: "Write something in your entry" };
    const body = cleanBody(input.body);
    if (!body) return { error: "Write something in your entry" };
    if (body.length > MAX_BLOG_BODY) return { error: `Entries can be up to ${MAX_BLOG_BODY} characters` };
    out.body = body;
  }
  if (partial && !Object.keys(out).length) return { error: "Nothing to change" };
  return out;
}

/** The first part of an entry, for lists: cut at a word, with the line breaks flattened. */
export function excerptOf(body, max = 200) {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
