import { areBlocked, areFriends } from "./visibility.js";
import { emptySummary } from "./reactions.js";

// Every place a User gets embedded in a response (search, friends lists,
// group rosters, comment/post authors, notification actors, top friends...)
// must respect the same rule the profile page itself enforces: a private
// user's profile content is visible only to themselves and accepted
// friends. `viewerId` is the currently logged-in caller, if any.
export async function toPublicUser(user, viewerId) {
  if (!user) return null;

  const isSelf = viewerId && String(user._id) === String(viewerId);
  if (isSelf) return user.toPublic({ includeEmail: true });
  if (!user.isPrivate) return user.toPublic();

  const isFriend = viewerId ? await areFriends(viewerId, user._id) : false;
  return isFriend ? user.toPublic() : user.toPublicRestricted();
}

// reactions: { likes, dislikes, myReaction, commentCount }
export function toPublicMediaItem(item, reactions = {}) {
  return {
    id: item._id,
    ownerId: item.owner,
    url: item.url,
    type: item.type,
    caption: item.caption,
    isAiImage: item.isAiImage,
    startSeconds: item.startSeconds ?? 0,
    durationSeconds: item.durationSeconds ?? null,
    albumId: item.album ?? null,
    reactions: reactions.reactions ?? emptySummary(),
    commentCount: reactions.commentCount ?? 0,
    createdAt: item.createdAt,
  };
}

export function toPublicTrack(track) {
  return {
    id: track._id,
    ownerId: track.owner,
    title: track.title,
    artist: track.artist ?? "",
    sourceType: track.sourceType,
    url: track.url,
    position: track.position,
    profileSong: Boolean(track.profileSong),
    plays: track.plays ?? 0,
    createdAt: track.createdAt,
  };
}

export async function toPublicComment(comment, viewerId) {
  return {
    id: comment._id,
    content: comment.content,
    imageUrl: comment.imageUrl ?? null,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt ?? null,
    author: await toPublicUser(comment.author, viewerId),
  };
}

/**
 * The post a repost shares, as this viewer may see it: the whole thing while its author is still public (not suspended, not blocked either
 * way with the viewer), otherwise just "unavailable", the same for a post that was deleted, so a repost can't be used to see a post the
 * viewer couldn't open.
 */
async function repostView(original, viewerId) {
  const author = original?.author;
  if (!original?._id || !author?._id || author.isPrivate || author.suspendedAt || (viewerId && (await areBlocked(viewerId, author._id)))) return { available: false };
  return {
    available: true,
    id: original._id,
    authorId: author._id,
    author: await toPublicUser(author, viewerId),
    content: original.content,
    imageUrl: original.imageUrl,
    imageAspect: original.imageAspect ?? null,
    imageZoom: original.imageZoom ?? null,
    imagePosition: original.imagePosition ?? null,
    createdAt: original.createdAt,
  };
}

// extras: { saved } (whether the viewer has saved it)
export async function toPublicPost(post, commentCount = 0, viewerId, reactions = emptySummary(), extras = {}) {
  return {
    id: post._id,
    authorId: post.author?._id ?? post.author,
    author: post.author ? await toPublicUser(post.author, viewerId) : undefined,
    content: post.content,
    imageUrl: post.imageUrl,
    imageAspect: post.imageAspect ?? null,
    imageZoom: post.imageZoom ?? null,
    imagePosition: post.imagePosition ?? null,
    isAiText: post.isAiText,
    isAiImage: post.isAiImage,
    createdAt: post.createdAt,
    editedAt: post.editedAt ?? null,
    commentCount,
    reactions,
    isRepost: Boolean(post.isRepost),
    repost: post.isRepost ? await repostView(post.repostOf, viewerId) : null,
    saved: extras.saved === true,
  };
}
