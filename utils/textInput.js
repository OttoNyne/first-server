import { cleanBody } from "./blogText.js";
import { createLimiter } from "./rateLimit.js";

// Limits on what people can write, in one place so posts, comments and testimonials are checked the same way.
export const MAX_POST = 5000;
export const MAX_COMMENT = 1000;

/** Text from a request: returns { value } (hidden characters removed, line breaks tidied) or { error }. Never silently cuts. */
export function checkText(value, max, label = "Text") {
  if (typeof value !== "string") return { error: `${label} must be text` };
  const cleaned = cleanBody(value);
  if (!cleaned) return { error: "Write something first" };
  if (cleaned.length > max) return { error: `${label} can be up to ${max} characters` };
  return { value: cleaned };
}

// Changing what you wrote: 60 an hour per person across everything that can be edited.
export const editLimiter = createLimiter({ name: "edit", limit: 60, windowMs: 60 * 60 * 1000 });

/** True if the person may make another edit; otherwise answers 429 and returns false. */
export async function allowEdit(req, res) {
  if (await editLimiter.allow(req.user.id)) return true;
  res.set("Retry-After", String(editLimiter.windowSeconds));
  res.status(429).json({ error: "You've changed a lot of things — try again later." });
  return false;
}

/** The cursor for "older than this one": an id, or nothing. Anything else is ignored. */
export function cursorFilter(query, mongoose, field = "before") {
  const raw = query?.[field];
  return typeof raw === "string" && mongoose.isValidObjectId(raw) ? raw : null;
}
