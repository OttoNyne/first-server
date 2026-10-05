import { deleteStoredAssetIfUnused } from "./storedAssets.js";

/**
 * Comments are gone (deleted, or their post or piece or account was): the pictures people attached to them were files we store for
 * those people, so each one is removed if nothing else still shows it. `comments` are the removed comment documents (or anything with
 * an `author` and an `imageUrl`). Never throws: a failed cleanup just leaves a file behind.
 */
export async function releasePictures(comments) {
  for (const comment of comments ?? []) {
    if (comment?.imageUrl) await deleteStoredAssetIfUnused({ ownerId: comment.author, url: comment.imageUrl });
  }
}
