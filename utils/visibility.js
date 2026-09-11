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

// Resolves a profile the way it's actually seen by a given viewer: 404 if the
// user doesn't exist, 403 if either has blocked the other, and 403 if the
// profile is private and the viewer isn't the owner or an accepted friend.
// Any route exposing data scoped to a single user (profile, tracks, media,
// posts, guestbook comments, top friends) must go through this — otherwise
// the isPrivate/block settings are silently bypassed for that data.
export async function getProfileForViewer(username, viewerId) {
  const user = await User.findOne({ username });
  if (!user) {
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
