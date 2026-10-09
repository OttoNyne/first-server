import { Save } from "../models/Save.js";

/** Which of these posts or pieces (ids) the viewer has saved: a Set of id strings. Nothing for someone who isn't signed in. */
export async function savedIdsOf(targetType, ids, viewerId) {
  if (!viewerId || !ids.length) return new Set();
  const rows = await Save.find({ user: viewerId, targetType, target: { $in: ids } }).select("target");
  return new Set(rows.map((r) => String(r.target)));
}
