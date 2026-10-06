import { Reaction } from "../models/Reaction.js";
import { Notification } from "../models/Notification.js";

export { REACTIONS, REACTION_KEYS, emojiOf, checkEmoji } from "./reactionKeys.js";
import { REACTION_KEYS } from "./reactionKeys.js";

export const emptySummary = () => ({ counts: Object.fromEntries(REACTION_KEYS.map((k) => [k, 0])), total: 0, mine: null });

/** How many of each emoji, in all, and the viewer's own, for a set of things: Map(id -> { counts, total, mine }). */
export async function summarise(targetType, ids, viewerId) {
  const out = new Map(ids.map((id) => [String(id), emptySummary()]));
  if (!ids.length) return out;
  const rows = await Reaction.aggregate([
    { $match: { targetType, target: { $in: ids } } },
    { $group: { _id: { target: "$target", emoji: "$emoji" }, n: { $sum: 1 } } },
  ]);
  for (const row of rows) {
    const summary = out.get(String(row._id.target));
    if (!summary || !(row._id.emoji in summary.counts)) continue;
    summary.counts[row._id.emoji] = row.n;
    summary.total += row.n;
  }
  if (viewerId) {
    for (const mine of await Reaction.find({ targetType, target: { $in: ids }, user: viewerId }).select("target emoji")) {
      const summary = out.get(String(mine.target));
      if (summary) summary.mine = mine.emoji;
    }
  }
  return out;
}

/**
 * Sets (or with null, removes) a person's reaction. Returns { created } : true when this is their first reaction to the thing (changing
 * from one emoji to another isn't).
 */
export async function setReaction({ targetType, target, user, emoji }) {
  if (emoji === null) {
    await Reaction.deleteOne({ targetType, target, user });
    return { created: false };
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const before = await Reaction.findOneAndUpdate({ targetType, target, user }, { $set: { emoji } }, { upsert: true, returnDocument: "before" });
      return { created: before === null };
    } catch (err) {
      // two requests from one person at once can both try to make it; the second just changes it
      if (err?.code === 11000 && attempt < 2) continue;
      throw err;
    }
  }
}

/**
 * Tells the owner someone reacted: once for each person and thing (changing the emoji, or taking it off and putting it back, doesn't tell
 * them again), and never for their own. A failure here never stops the reaction.
 */
export async function notifyOfReaction({ ownerId, actorId, targetType, target, emoji }) {
  try {
    if (String(ownerId) === String(actorId)) return;
    const already = await Notification.exists({ recipient: ownerId, type: "reaction", "payload.actorId": String(actorId), "payload.targetId": String(target) });
    if (already) return;
    await Notification.create({ recipient: ownerId, type: "reaction", payload: { actorId: String(actorId), targetType, targetId: String(target), emoji } });
  } catch (err) {
    console.error("Couldn't notify of a reaction:", err.message);
  }
}

/** Things are gone: so are the reactions on them, and the notes about those reactions. */
export async function forgetReactions(targetType, ids) {
  if (!ids.length) return;
  await Reaction.deleteMany({ targetType, target: { $in: ids } });
  await Notification.deleteMany({ type: "reaction", "payload.targetType": targetType, "payload.targetId": { $in: ids.map(String) } });
}
