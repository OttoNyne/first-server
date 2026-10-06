// The fixed set of emoji reactions on portfolio pieces and posts. Someone picks one of these six (so counts stay tidy and nothing odd can
// be put on someone's work), has at most one on each thing, and can change it or take it away.

export const REACTIONS = [
  { key: "like", emoji: "👍", name: "Like" },
  { key: "love", emoji: "❤️", name: "Love" },
  { key: "laugh", emoji: "😂", name: "Haha" },
  { key: "wow", emoji: "😮", name: "Wow" },
  { key: "sad", emoji: "😢", name: "Sad" },
  { key: "fire", emoji: "🔥", name: "Fire" },
];
export const REACTION_KEYS = REACTIONS.map((r) => r.key);
export const emojiOf = (key) => REACTIONS.find((r) => r.key === key)?.emoji ?? "";

/** What a person sent as their reaction: { value: key } or { value: null } to take it away, or { error }. */
export function checkEmoji(input) {
  if (input === null) return { value: null };
  if (typeof input === "string" && REACTION_KEYS.includes(input)) return { value: input };
  return { error: `emoji must be one of ${REACTION_KEYS.join(", ")}, or null to take your reaction away` };
}
