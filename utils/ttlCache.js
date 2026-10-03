// A tiny in-memory cache whose entries expire on their own. Used for facts that a busy room asks the
// database for again and again but that rarely change (is this person in this room? who has this person
// blocked?). It is per server process and only ever makes the answer a few seconds stale; anything that
// changes the answer clears it.
export function createTtlCache(ttlMs, maxEntries = 5000) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.until < Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value); // oldest first
      entries.set(key, { value, until: Date.now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
