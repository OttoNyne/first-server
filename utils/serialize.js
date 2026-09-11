export function toPublicUser(user) {
  if (!user) return null;
  return user.toPublic ? user.toPublic() : user;
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
