import { Friendship } from "../models/Friendship.js";
import { User } from "../models/User.js";
import { DismissedSuggestion } from "../models/DismissedSuggestion.js";
import { blockedUserIds } from "./visibility.js";

// Who knows whom, for "mutual friends" and "people you may know". A friendship is an accepted Friendship in either direction.
//
// Privacy rule used throughout: a person who has turned off `showConnections` is never used to connect other people. They are not named
// as a mutual friend, not suggested to anyone, and their own friends are not suggested through them, so switching it off hides who they
// know from everyone but their friends' own lists.

export const MAX_SUGGESTIONS = 12;
export const MAX_MUTUAL_SHOWN = 8;
const SCAN_FRIENDS = 300; // how many of a person's friends are looked through
const SCAN_PAIRS = 6000; // how many friendships among them are looked through

/** The ids (as strings) of a person's accepted friends. */
export async function friendIdsOf(userId) {
  const rows = await Friendship.find({ status: "accepted", $or: [{ requester: userId }, { addressee: userId }] }).select("requester addressee").limit(5000);
  return new Set(rows.map((f) => (String(f.requester) === String(userId) ? String(f.addressee) : String(f.requester))));
}

/** Of these ids, the ones that may be used to connect people: not suspended, and not switched off. */
async function usable(ids) {
  if (!ids.length) return new Set();
  const users = await User.find({ _id: { $in: ids }, suspendedAt: null, showConnections: { $ne: false } }).select("_id");
  return new Set(users.map((u) => String(u._id)));
}

/** The people who are friends of both: [user ids]. Empty if the target has switched connections off. */
export async function mutualIds(viewerId, target) {
  if (String(viewerId) === String(target._id) || target.showConnections === false) return [];
  const [mine, theirs] = await Promise.all([friendIdsOf(viewerId), friendIdsOf(target._id)]);
  const both = [...mine].filter((id) => theirs.has(id));
  const ok = await usable(both);
  return both.filter((id) => ok.has(id));
}

/** How many mutual friends each of these people has with the viewer: Map(personId -> count). For a list such as friend requests or search results. */
export async function mutualCounts(viewerId, people) {
  const result = new Map();
  for (const p of people) result.set(String(p._id), 0);
  const mine = [...(await friendIdsOf(viewerId))];
  const shown = people.filter((p) => p.showConnections !== false);
  if (!mine.length || !shown.length) return result;
  // one look-up for every friendship between these people and the viewer's friends, so no more rows than there are mutual friends
  const ids = shown.map((p) => p._id);
  const rows = await Friendship.find({ status: "accepted", $or: [{ requester: { $in: ids }, addressee: { $in: mine } }, { addressee: { $in: ids }, requester: { $in: mine } }] }).select("requester addressee");
  const mineSet = new Set(mine);
  const shownIds = new Set(ids.map(String));
  const through = new Map(); // person -> the viewer's friends who know them
  for (const r of rows) {
    const x = String(r.requester);
    const y = String(r.addressee);
    const [person, friend] = shownIds.has(x) && mineSet.has(y) ? [x, y] : [y, x];
    if (!through.has(person)) through.set(person, new Set());
    through.get(person).add(friend);
  }
  const ok = await usable([...new Set([...through.values()].flatMap((set) => [...set]))]);
  for (const [person, set] of through) result.set(person, [...set].filter((f) => ok.has(f)).length);
  return result;
}

/**
 * People the viewer may know: friends of their friends who are not already connected to them in any way (no friendship, pending request
 * or block), whose profiles are public and who have not switched connections off or been dismissed. Ranked by how many friends they share.
 * Returns [{ user, mutualCount, mutual: [users] }] with at most `limit`.
 */
export async function suggestionsFor(viewerId, limit = MAX_SUGGESTIONS) {
  const mine = [...(await friendIdsOf(viewerId))].slice(0, SCAN_FRIENDS);
  if (!mine.length) return [];
  const connectors = await usable(mine);
  const useIds = mine.filter((id) => connectors.has(id));
  if (!useIds.length) return [];

  const [pairs, related, blocked, dismissed] = await Promise.all([
    Friendship.find({ status: "accepted", $or: [{ requester: { $in: useIds } }, { addressee: { $in: useIds } }] }).select("requester addressee").limit(SCAN_PAIRS),
    Friendship.find({ $or: [{ requester: viewerId }, { addressee: viewerId }] }).select("requester addressee"),
    blockedUserIds(viewerId),
    DismissedSuggestion.find({ owner: viewerId }).select("target"),
  ]);
  const skip = new Set([String(viewerId), ...blocked, ...dismissed.map((d) => String(d.target))]);
  for (const f of related) skip.add(String(f.requester)).add(String(f.addressee));

  const through = new Map(); // candidate -> the friends of the viewer who know them
  const via = new Set(useIds);
  for (const p of pairs) {
    const a = String(p.requester);
    const b = String(p.addressee);
    for (const [friend, other] of [[a, b], [b, a]]) {
      if (via.has(friend) && !skip.has(other)) {
        if (!through.has(other)) through.set(other, new Set());
        through.get(other).add(friend);
      }
    }
  }
  if (!through.size) return [];

  const candidates = await User.find({ _id: { $in: [...through.keys()] }, isPrivate: { $ne: true }, suspendedAt: null, showConnections: { $ne: false } });
  const ranked = candidates
    .map((user) => ({ user, ids: [...through.get(String(user._id))] }))
    .sort((x, y) => y.ids.length - x.ids.length || String(y.user._id).localeCompare(String(x.user._id)))
    .slice(0, limit);
  const named = await User.find({ _id: { $in: [...new Set(ranked.flatMap((r) => r.ids.slice(0, 3)))] } });
  const byId = new Map(named.map((u) => [String(u._id), u]));
  return ranked.map((r) => ({ user: r.user, mutualCount: r.ids.length, mutual: r.ids.slice(0, 3).map((id) => byId.get(id)).filter(Boolean) }));
}
