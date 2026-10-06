import { cleanLine } from "./profileFields.js";

export const MAX_CAPTION = 200;

/**
 * A caption for a portfolio piece, as stored: one line of plain text, no hidden or control characters, at most 200 characters.
 * Returns { value } (null when there is nothing to keep, which is how a caption is taken off) or { error }.
 * Captions are plain text: web addresses in them are not made into links.
 */
export function checkCaption(input) {
  if (input === undefined || input === null) return { value: null };
  if (typeof input !== "string") return { error: `Caption must be text of ${MAX_CAPTION} characters or fewer` };
  const value = cleanLine(input);
  if ([...value].length > MAX_CAPTION) return { error: `Caption must be text of ${MAX_CAPTION} characters or fewer` };
  return { value: value || null };
}
