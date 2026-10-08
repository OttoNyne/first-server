// Cleaning for the small free-text fields on a profile: a mood, what someone is listening to, and tags.

export const MAX_MOOD = 60;
export const MAX_LISTENING = 80;
export const MAX_TAGS = 8;
export const MIN_TAG = 2;
export const MAX_TAG = 24;

// Everything that isn't printable (newlines, tabs, control and zero-width characters) is dropped, and runs of spaces collapse.
// Anything else is kept as typed, including < and &: it is only ever drawn as plain text, never as markup.
const UNPRINTABLE = new RegExp("[" + [[0, 31], [127, 159], [8203, 8207], [8232, 8238], [8288, 8303], [65279, 65279]].map(([from, to]) => String.fromCodePoint(from) + "-" + String.fromCodePoint(to)).join("") + "]", "g");
export const cleanLine = (value) => value.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();

/** A one-line free-text field: returns { value } (possibly "") or { error }. */
export function checkLine(value, max, label) {
  if (typeof value !== "string") return { error: `${label} must be text` };
  const cleaned = cleanLine(value);
  if (cleaned.length > max) return { error: `${label} can be up to ${max} characters` };
  return { value: cleaned };
}

// Letters and numbers in any language, then letters, numbers, spaces and hyphens.
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u;

/** One tag as stored: lower case, no leading #, single spaces. Returns "" for something that isn't a tag. */
export function normalizeTag(value) {
  if (typeof value !== "string") return "";
  return cleanLine(value).replace(/^#+/, "").trim().toLowerCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, " ");
}

export const isValidTag = (tag) => tag.length >= MIN_TAG && tag.length <= MAX_TAG && TAG.test(tag);

export const MAX_OFFERS = 5;
export const MAX_WORK_NOTE = 140;

/** What someone offers when they are open to work ("logo design", "mixing"): a list of up to five tag-like words. Returns { value } or { error }. */
export function checkOffers(list) {
  if (!Array.isArray(list)) return { error: "workOffers must be a list" };
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") return { error: "Each offer must be text" };
    const offer = normalizeTag(raw);
    if (!isValidTag(offer)) return { error: `"${cleanLine(raw).slice(0, 30)}" isn't a valid offer — use ${MIN_TAG}–${MAX_TAG} letters, numbers, spaces or hyphens` };
    seen.add(offer);
  }
  if (seen.size > MAX_OFFERS) return { error: `You can list up to ${MAX_OFFERS} things you offer` };
  return { value: [...seen] };
}

/** A list of tags: returns { value: [...] } (cleaned, no repeats) or { error }. */
export function checkTags(list) {
  if (!Array.isArray(list)) return { error: "tags must be a list" };
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") return { error: "Each tag must be text" };
    const tag = normalizeTag(raw);
    if (!isValidTag(tag)) return { error: `"${cleanLine(raw).slice(0, 30)}" isn't a valid tag — use ${MIN_TAG}–${MAX_TAG} letters, numbers, spaces or hyphens` };
    seen.add(tag);
  }
  if (seen.size > MAX_TAGS) return { error: `You can have up to ${MAX_TAGS} tags` };
  return { value: [...seen] };
}
