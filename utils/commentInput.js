import { StoredAsset } from "../models/StoredAsset.js";
import { cleanBody } from "./blogText.js";

// What goes into a comment: words, links (as plain text), and one picture. Used the same way by comments on posts, testimonials on a
// profile and comments on a portfolio piece.

/** Links are only ever written in the text; this is the most one comment can have, so a comment can't be a wall of them. */
export const MAX_COMMENT_LINKS = 3;
// A web address in the text: what the site turns into a link when it draws a comment (see the frontend's lib/links.ts).
const LINK = /https?:\/\/[^\s<>"']+/gi;
export const countLinks = (text) => (text.match(LINK) ?? []).length;

/**
 * A comment from a request: { value } with the fields to store (content, and imageUrl when it was given), or { error }.
 *
 *   content   text; may be empty if there is a picture
 *   imageUrl  a picture the person uploaded here (never an address they just typed): checked against the files the site stored for them
 *
 * Changing one (`current` is the stored comment): the words can be changed, and the picture can be taken off (`imageUrl: null`) but not
 * swapped for another, because a new picture is a new thing for people to look at; that is a new comment.
 */
export async function checkComment(body, { userId, max, label, current = null }) {
  const out = {};
  const changing = Boolean(current);

  if (body?.content !== undefined) {
    if (typeof body.content !== "string") return { error: `${label} must be text` };
    const content = cleanBody(body.content);
    if (content.length > max) return { error: `${label} can be up to ${max} characters` };
    if (countLinks(content) > MAX_COMMENT_LINKS) return { error: `${label} can have up to ${MAX_COMMENT_LINKS} links` };
    out.content = content;
  } else if (!changing) {
    out.content = "";
  }

  if (body?.imageUrl !== undefined && body.imageUrl !== null) {
    if (changing) return { error: "A picture can be taken off a comment but not changed — post a new comment instead" };
    if (typeof body.imageUrl !== "string" || !body.imageUrl) return { error: "The picture must be one you uploaded" };
    const stored = await StoredAsset.exists({ owner: userId, url: body.imageUrl, kind: "upload", resourceType: "image" });
    if (!stored) return { error: "Add a picture by uploading it first" };
    out.imageUrl = body.imageUrl;
  } else if (body?.imageUrl === null && changing) {
    out.imageUrl = null;
  }

  if (changing && !Object.keys(out).length) return { error: "Nothing to change" };
  const words = out.content ?? current?.content ?? "";
  const picture = out.imageUrl !== undefined ? out.imageUrl : (current?.imageUrl ?? null);
  if (!words && !picture) return { error: changing ? "A comment needs words or a picture" : "Write something first" };
  return { value: out };
}
