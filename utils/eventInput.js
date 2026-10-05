import { cleanBody } from "./blogText.js";
import { cleanLine } from "./profileFields.js";

export const MAX_EVENT_TITLE = 80;
export const MAX_EVENT_DESCRIPTION = 1000;
export const MAX_EVENT_PLACE = 120;
export const MAX_EVENT_LINK = 300;
export const MIN_LEAD_MS = 5 * 60 * 1000; // an event is for later, not for now
export const MAX_LEAD_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_LENGTH_MS = 3 * 24 * 60 * 60 * 1000;

/** A web address people may be sent to: https only, no name or password in it. Returns the cleaned address or null. */
export function safeLink(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_EVENT_LINK) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
  return url.toString();
}

const asDate = (value) => (typeof value === "string" && value ? new Date(value) : null);

/**
 * The fields of an event from a request: { value } with only the fields that were given (all of them for a new event), or { error }.
 * `current` is the event being changed, so a change is checked as a whole (a place for an in-person event, an end after the start).
 */
export function checkEvent(input, { current = null, now = Date.now() } = {}) {
  const partial = Boolean(current);
  const out = {};
  const has = (key) => input?.[key] !== undefined;

  if (has("title") || !partial) {
    const title = typeof input?.title === "string" ? cleanLine(input.title) : "";
    if (!title) return { error: "Give your event a title" };
    if (title.length > MAX_EVENT_TITLE) return { error: `Titles can be up to ${MAX_EVENT_TITLE} characters` };
    out.title = title;
  }
  if (has("description")) {
    if (typeof input.description !== "string") return { error: "The description must be text" };
    const description = cleanBody(input.description);
    if (description.length > MAX_EVENT_DESCRIPTION) return { error: `Descriptions can be up to ${MAX_EVENT_DESCRIPTION} characters` };
    out.description = description;
  }
  if (has("kind") || !partial) {
    const kind = input?.kind ?? "in_person";
    if (kind !== "in_person" && kind !== "online") return { error: "An event is in person or online" };
    out.kind = kind;
  }
  if (has("audience") || !partial) {
    const audience = input?.audience ?? "friends";
    if (audience !== "friends" && audience !== "public") return { error: "An event is for friends or for everyone" };
    out.audience = audience;
  }

  if (has("startsAt") || !partial) {
    const startsAt = asDate(input?.startsAt);
    if (!startsAt || Number.isNaN(startsAt.getTime())) return { error: "Choose a start time" };
    if (startsAt.getTime() - now < MIN_LEAD_MS) return { error: "Choose a time at least 5 minutes from now" };
    if (startsAt.getTime() - now > MAX_LEAD_MS) return { error: "You can plan up to 90 days ahead" };
    out.startsAt = startsAt;
  }
  if (has("endsAt")) {
    if (input.endsAt === null || input.endsAt === "") out.endsAt = null;
    else {
      const endsAt = asDate(input.endsAt);
      if (!endsAt || Number.isNaN(endsAt.getTime())) return { error: "Choose a valid end time, or none" };
      out.endsAt = endsAt;
    }
  }
  const startsAt = out.startsAt ?? current?.startsAt;
  const endsAt = out.endsAt !== undefined ? out.endsAt : (current?.endsAt ?? null);
  if (endsAt) {
    if (endsAt.getTime() <= startsAt.getTime()) return { error: "The end has to be after the start" };
    if (endsAt.getTime() - startsAt.getTime() > MAX_LENGTH_MS) return { error: "An event can last up to 3 days" };
  }

  const kind = out.kind ?? current?.kind ?? "in_person";
  if (has("place")) {
    if (typeof input.place !== "string") return { error: "The place must be text" };
    const place = cleanLine(input.place);
    if (place.length > MAX_EVENT_PLACE) return { error: `Places can be up to ${MAX_EVENT_PLACE} characters` };
    out.place = place;
  }
  if (has("link")) {
    if (input.link === null || input.link === "") out.link = "";
    else {
      const link = safeLink(input.link);
      if (!link) return { error: "The link must be a web address starting with https://" };
      out.link = link;
    }
  }
  // what the kind needs, and nothing it doesn't use
  if (kind === "in_person") {
    const place = out.place ?? current?.place ?? "";
    if (!place) return { error: "Say where it is" };
    out.link = "";
  } else {
    out.place = "";
  }
  return { value: out };
}
