import { Spotlight } from "../models/Spotlight.js";
import { MediaItem } from "../models/MediaItem.js";
import { User } from "../models/User.js";

export const SLOTS = [1, 2];
export const MAX_NOTE = 140;
const TAGS_SHOWN = 3;

/** Why a person can't be shown on the main screen, or null if they can: gone, suspended, or a private profile (the screen is public). */
export const hiddenReason = (user) => (!user ? "missing" : user.suspendedAt ? "suspended" : user.isPrivate ? "private" : null);

/** What the main screen shows about a person: public facts only. */
export const spotlightPerson = (user) => ({
  id: user._id,
  username: user.username,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl ?? null,
  headline: user.headline ?? "",
  csVerified: Boolean(user.csVerifiedByAdmin || user.csVerifiedEarned),
  tags: (user.tags ?? []).slice(0, TAGS_SHOWN),
});

/** The picture a spotlight shows: the one chosen if it is still the person's, else their featured piece, else their latest picture. */
export async function shownPiece(spot, user) {
  const image = (id) => (id ? MediaItem.findOne({ _id: id, owner: user._id, type: "image" }) : null);
  const found = (await image(spot.piece)) ?? (await image(user.featuredPiece)) ?? (await MediaItem.findOne({ owner: user._id, type: "image" }).sort("-createdAt"));
  return found ? { id: found._id, url: found.url, caption: found.caption ?? null } : null;
}

/** The spotlights the public main screen shows, by slot: only the people who can be shown, so a slot whose person went private, was suspended or left is simply empty. */
export async function currentSpotlights() {
  const spots = await Spotlight.find().sort({ slot: 1 });
  const users = await User.find({ _id: { $in: spots.map((s) => s.user) } });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const shown = [];
  for (const spot of spots) {
    const user = byId.get(String(spot.user));
    if (hiddenReason(user)) continue;
    shown.push({ slot: spot.slot, note: spot.note, user: spotlightPerson(user), piece: await shownPiece(spot, user) });
  }
  return shown;
}

/** Both slots as an administrator sees them: who is in each, what was chosen, and whether the person can be shown right now. */
export async function adminSlots() {
  const spots = await Spotlight.find();
  const users = await User.find({ _id: { $in: spots.map((s) => s.user) } });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const slots = [];
  for (const slot of SLOTS) {
    const spot = spots.find((s) => s.slot === slot);
    if (!spot) {
      slots.push({ slot, empty: true });
      continue;
    }
    const user = byId.get(String(spot.user));
    slots.push({
      slot,
      empty: false,
      note: spot.note,
      chosenPiece: spot.piece ? String(spot.piece) : null,
      hidden: hiddenReason(user),
      user: user ? spotlightPerson(user) : null,
      piece: user ? await shownPiece(spot, user) : null,
      since: spot.updatedAt,
    });
  }
  return slots;
}
