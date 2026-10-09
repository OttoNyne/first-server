import { User } from "../models/User.js";
import { Block } from "../models/Block.js";
import { Friendship } from "../models/Friendship.js";

export async function areBlocked(idA, idB) {
  const block = await Block.findOne({
    $or: [
      { blocker: idA, blocked: idB },
      { blocker: idB, blocked: idA },
    ],
  });
  return !!block;
}

/** A test for "may this viewer see this person's things": not suspended, not blocked either way, and not private unless a friend (or themselves). */
export async function visibleToViewer(viewerId) {
  const [blocked, friendships] = await Promise.all([blockedUserIds(viewerId), Friendship.find({ status: "accepted", $or: [{ requester: viewerId }, { addressee: viewerId }] })]);
  const friends = new Set(friendships.map((f) => (String(f.requester) === String(viewerId) ? String(f.addressee) : String(f.requester))));
  return (owner) => Boolean(owner) && !owner.suspendedAt && !blocked.has(String(owner._id)) && (!owner.isPrivate || friends.has(String(owner._id)) || String(owner._id) === String(viewerId));
}

// Ids of everyone the viewer has blocked or been blocked by (either direction hides them).
export async function blockedUserIds(viewerId) {
  const blocks = await Block.find({ $or: [{ blocker: viewerId }, { blocked: viewerId }] });
  return new Set(blocks.map((b) => (String(b.blocker) === String(viewerId) ? String(b.blocked) : String(b.blocker))));
}

export async function areFriends(idA, idB) {
  const friendship = await Friendship.findOne({
    status: "accepted",
    $or: [
      { requester: idA, addressee: idB },
      { requester: idB, addressee: idA },
    ],
  });
  return !!friendship;
}

// Throws (404/403) unless `viewerId` is allowed to see `user`'s content: the
// user themselves, an accepted friend, or anyone at all if the profile isn't
// private — and never if either side has blocked the other. Any route
// exposing data scoped to a single user (profile, tracks, media, posts,
// comments on those posts, guestbook comments, top friends) must go through
// this — otherwise the isPrivate/block settings are silently bypassed.
export async function assertVisible(user, viewerId) {
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  // A suspended account's profile (and so everything reached through it) is not found, except by the person themself.
  if (user.suspendedAt && String(user._id) !== String(viewerId)) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  if (viewerId && (await areBlocked(viewerId, user._id))) {
    const err = new Error("Profile not available");
    err.status = 403;
    throw err;
  }

  if (user.isPrivate && String(user._id) !== String(viewerId)) {
    const isFriend = viewerId ? await areFriends(viewerId, user._id) : false;
    if (!isFriend) {
      const err = new Error("This profile is private");
      err.status = 403;
      throw err;
    }
  }

  return user;
}

export async function getProfileForViewer(username, viewerId) {
  const user = await User.findOne({ username });
  return assertVisible(user, viewerId);
}
