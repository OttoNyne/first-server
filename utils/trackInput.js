import { cleanLine } from "./profileFields.js";

export const MAX_TRACKS = 20;
// Uploaded songs are files we pay to store; YouTube links cost nothing, so they can fill the rest of the list.
export const MAX_UPLOADS = 5;
export const MAX_TRACK_TITLE = 100;
export const MAX_TRACK_ARTIST = 80;

/**
 * A track's title and artist from a request: { value } with the fields that were given, or { error }. `partial` is for a change (a title
 * can't be emptied then); a new track with no title is called "Untitled track".
 */
export function checkTrackText(input, { partial = false } = {}) {
  const out = {};
  if (input?.title !== undefined || !partial) {
    if (input?.title !== undefined && typeof input.title !== "string") return { error: "The title must be text" };
    const title = cleanLine(input?.title ?? "");
    if (title.length > MAX_TRACK_TITLE) return { error: `Titles can be up to ${MAX_TRACK_TITLE} characters` };
    if (!title && partial) return { error: "A track needs a title" };
    out.title = title || "Untitled track";
  }
  if (input?.artist !== undefined) {
    if (typeof input.artist !== "string") return { error: "The artist must be text" };
    const artist = cleanLine(input.artist);
    if (artist.length > MAX_TRACK_ARTIST) return { error: `Artist names can be up to ${MAX_TRACK_ARTIST} characters` };
    out.artist = artist;
  }
  return { value: out };
}
