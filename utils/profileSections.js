// The parts of a profile page below the introduction, which the owner can put in any order and hide.

export const SECTION_KEYS = ["about", "friends", "music", "portfolio", "blog", "testimonials"];

const known = (key) => SECTION_KEYS.includes(key);

/** Every section once, in the saved order: anything unknown or repeated is dropped, and sections the list doesn't mention (a new kind of section) follow in the usual order. */
export function completeOrder(saved) {
  const seen = new Set();
  const order = [];
  for (const key of Array.isArray(saved) ? saved : []) {
    if (known(key) && !seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }
  return [...order, ...SECTION_KEYS.filter((key) => !seen.has(key))];
}

/** The hidden sections, known and without repeats. */
export const cleanHidden = (saved) => [...new Set((Array.isArray(saved) ? saved : []).filter(known))];

/** A new order from the owner: it has to be every section, exactly once. Returns { value } or { error }. */
export function checkOrder(value) {
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) return { error: "sectionOrder must be a list of section names" };
  if (value.length !== SECTION_KEYS.length || new Set(value).size !== value.length || !value.every(known)) {
    return { error: `sectionOrder must list each of ${SECTION_KEYS.join(", ")} exactly once` };
  }
  return { value };
}

/** The sections to hide: any of the known ones, each once. Returns { value } or { error }. */
export function checkHidden(value) {
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) return { error: "hiddenSections must be a list of section names" };
  if (!value.every(known) || new Set(value).size !== value.length) return { error: `hiddenSections can only name each of ${SECTION_KEYS.join(", ")} once` };
  return { value };
}
