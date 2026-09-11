export function toPublicUser(user) {
  if (!user) return null;
  return user.toPublic ? user.toPublic() : user;
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

export function toPublicComment(comment) {
  return {
    id: comment._id,
    content: comment.content,
    createdAt: comment.createdAt,
    author: toPublicUser(comment.author),
  };
}

export function toPublicPost(post, commentCount = 0) {
  return {
    id: post._id,
    authorId: post.author?._id ?? post.author,
    author: post.author?.toPublic ? post.author.toPublic() : undefined,
    content: post.content,
    imageUrl: post.imageUrl,
    isAiText: post.isAiText,
    isAiImage: post.isAiImage,
    createdAt: post.createdAt,
    commentCount,
  };
}
