import { MediaReaction } from "../models/MediaReaction.js";
import { Reaction } from "../models/Reaction.js";

// Reactions used to be a like or a dislike on portfolio pieces. Each old like becomes the 👍 reaction; dislikes have no emoji to become
// and are dropped (by design: there is no dislike now). Safe to run any number of times, and from several servers at once: a like that
// has already been carried over (or that the person has since changed) is left as it is, and when the old collection is empty it does
// nothing.
const BATCH = 500;
export async function migrateMediaReactions() {
  let carried = 0;
  for (;;) {
    const old = await MediaReaction.find().limit(BATCH);
    if (!old.length) break;
    const likes = old.filter((r) => r.value === 1);
    if (likes.length) {
      try {
        await Reaction.bulkWrite(likes.map((r) => ({ updateOne: { filter: { targetType: "media", target: r.item, user: r.user }, update: { $setOnInsert: { emoji: "like" } }, upsert: true } })), { ordered: false });
      } catch (err) {
        // another server carrying the same likes over at the same moment got there first: that like is already a reaction
        const onlyDuplicates = err?.code === 11000 || (Array.isArray(err?.writeErrors) && err.writeErrors.every((w) => w.code === 11000));
        if (!onlyDuplicates) throw err;
      }
      carried += likes.length;
    }
    await MediaReaction.deleteMany({ _id: { $in: old.map((r) => r._id) } });
  }
  return carried;
}
