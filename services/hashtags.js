import { Post } from "../models/Post.js";
import { MediaItem } from "../models/MediaItem.js";
import { hashtagsIn } from "../utils/hashtags.js";

const BATCH = 500;

/**
 * Posts and pieces made before hashtags existed have no tags field. This gives each one its tags (an empty list when it has none, so it is
 * not looked at again), a batch at a time. Safe to run on every start: once everything has been done it finds nothing. Returns how many it did.
 */
export async function backfillHashtags() {
  let done = 0;
  for (const [model, field] of [[Post, "content"], [MediaItem, "caption"]]) {
    for (;;) {
      const batch = await model.find({ tags: { $exists: false } }).limit(BATCH).select(field);
      if (!batch.length) break;
      await model.bulkWrite(batch.map((doc) => ({ updateOne: { filter: { _id: doc._id }, update: { $set: { tags: hashtagsIn(doc[field]) } } } })));
      done += batch.length;
    }
  }
  return done;
}
