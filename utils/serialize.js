import { areFriends } from "./visibility.js";

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

export function toPublicMediaItem(item) {
  return {
    id: item._id,
    ownerId: item.owner,
    url: item.url,
    type: item.type,
    caption: item.caption,
    isAiImage: item.isAiImage,
    createdAt: item.createdAt,
  };
}

export function toPublicTrack(track) {
  return {
    id: track._id,
    ownerId: track.owner,
    title: track.title,
    sourceType: track.sourceType,
    url: track.url,
    position: track.position,
    createdAt: track.createdAt,
  };
}

export async function toPublicComment(comment, viewerId) {
  return {
    id: comment._id,
    content: comment.content,
    createdAt: comment.createdAt,
    author: await toPublicUser(comment.author, viewerId),
  };
}

export async function toPublicPost(post, commentCount = 0, viewerId) {
  return {
    id: post._id,
    authorId: post.author?._id ?? post.author,
    author: post.author ? await toPublicUser(post.author, viewerId) : undefined,
    content: post.content,
    imageUrl: post.imageUrl,
    isAiText: post.isAiText,
    isAiImage: post.isAiImage,
    createdAt: post.createdAt,
    commentCount,
  };
}
