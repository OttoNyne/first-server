import { cleanBody } from "./blogText.js";
import { cleanLine } from "./profileFields.js";

// The "About me" section of a profile: a few short free-text answers, an optional place, and an optional birthday (month and day, never a
// year or an age). Everything is plain text. Place and birthday are things a person chooses to share; leaving them empty shares nothing.

export const ABOUT_FIELDS = ["interests", "music", "movies", "books", "meet"];
export const ABOUT_LABELS = { interests: "Interests", music: "Favourite music", movies: "Favourite films and shows", books: "Favourite books", meet: "Who I'd like to meet" };
export const MAX_ABOUT = 300;
export const MAX_LOCATION = 60;
export const LOCATION_AUDIENCES = ["friends", "everyone"];

// 2020 is a leap year, so 29 February is a real day; that is the one extra day a birthday can have.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A birthday { month, day } that exists on a calendar, or null if it doesn't. */
export function cleanBirthday(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { month, day } = value;
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return { month, day };
}

/**
 * What the owner sent, as the fields to store: { value } with only what was given, or { error }.
 *   { interests, music, movies, books, meet }  — text up to 300 characters each ("" clears one)
 *   { location }  — a line of up to 60 characters ("" clears it); { locationAudience } — friends or everyone
 *   { birthday }  — { month, day } or null to stop sharing it
 */
export function checkAbout(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Send the fields you want to change" };
  const out = {};
  for (const field of ABOUT_FIELDS) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "string") return { error: `${ABOUT_LABELS[field]} must be text` };
    const text = cleanBody(input[field]);
    if (text.length > MAX_ABOUT) return { error: `${ABOUT_LABELS[field]} can be up to ${MAX_ABOUT} characters` };
    out[field] = text;
  }
  if (input.location !== undefined) {
    if (typeof input.location !== "string") return { error: "Location must be text" };
    const location = cleanLine(input.location);
    if (location.length > MAX_LOCATION) return { error: `Location can be up to ${MAX_LOCATION} characters` };
    out.location = location;
  }
  if (input.locationAudience !== undefined) {
    if (!LOCATION_AUDIENCES.includes(input.locationAudience)) return { error: "locationAudience must be friends or everyone" };
    out.locationAudience = input.locationAudience;
  }
  if (input.birthday !== undefined) {
    if (input.birthday === null) out.birthday = null;
    else {
      const birthday = cleanBirthday(input.birthday);
      if (!birthday) return { error: "Choose a real month and day for your birthday" };
      out.birthday = birthday;
    }
  }
  if (!Object.keys(out).length) return { error: "Nothing to change" };
  return { value: out };
}
