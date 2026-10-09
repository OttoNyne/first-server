import { Comment } from "../models/Comment.js";
import { MediaComment } from "../models/MediaComment.js";
import { ProcessStep } from "../models/ProcessStep.js";
import { PollVote } from "../models/PollVote.js";
import { Save } from "../models/Save.js";
import { Credit } from "../models/Credit.js";
import { ChallengeEntry } from "../models/ChallengeEntry.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { CallApplication } from "../models/CallApplication.js";
import { forgetReactions } from "../utils/reactions.js";
import { releasePictures } from "./commentPictures.js";
import { deleteStoredAssetIfUnused } from "./storedAssets.js";

// Taking things away, in one place: the person who made it deleting it, and a moderator removing it, must leave nothing behind (its
// comments and their pictures, reactions, saves, votes, pointers, notices and stored files).

/** A post and everything that hangs off it. */
export async function deletePost(post) {
  const withPictures = await Comment.find({ post: post._id, imageUrl: { $ne: null } });
  await Comment.deleteMany({ post: post._id });
  await releasePictures(withPictures);
  await post.deleteOne();
  await forgetReactions("post", [post._id]);
  await Save.deleteMany({ targetType: "post", target: post._id });
  await PollVote.deleteMany({ post: post._id });
  await User.updateOne({ _id: post.author, pinnedPost: post._id }, { $set: { pinnedPost: null } });
  await Notification.deleteMany({ type: "repost", "payload.postId": String(post._id) });
  // An AI-generated image that only this post used would otherwise sit on Cloudinary forever.
  if (post.imageUrl) await deleteStoredAssetIfUnused({ ownerId: post.author, url: post.imageUrl });
}

/** A portfolio piece, its steps, comments, credits, entries and saves. */
export async function deletePiece(item) {
  await item.deleteOne();
  await forgetReactions("media", [item._id]);
  await Credit.deleteMany({ item: item._id });
  await ChallengeEntry.deleteMany({ item: item._id });
  await Save.deleteMany({ targetType: "piece", target: item._id });
  const steps = await ProcessStep.find({ piece: item._id });
  await ProcessStep.deleteMany({ piece: item._id });
  await releasePictures(steps.map((s) => ({ author: s.owner, imageUrl: s.imageUrl })));
  await User.updateOne({ _id: item.owner, featuredPiece: item._id }, { $set: { featuredPiece: null } });
  await Notification.deleteMany({ type: { $in: ["credit_request", "credit_accepted"] }, "payload.itemId": String(item._id) });
  const withPictures = await MediaComment.find({ item: item._id, imageUrl: { $ne: null } });
  await MediaComment.deleteMany({ item: item._id });
  await releasePictures(withPictures);
  await deleteStoredAssetIfUnused({ ownerId: item.owner, url: item.url });
}

/** One step of a piece's process, and its picture. */
export async function deleteStep(step) {
  await step.deleteOne();
  await releasePictures([{ author: step.owner, imageUrl: step.imageUrl }]);
}

/** An open call with its answers and the notices about it. */
export async function deleteCall(call) {
  await call.deleteOne();
  await CallApplication.deleteMany({ call: call._id });
  await Notification.deleteMany({ type: { $in: ["call_match", "call_application", "call_answer"] }, "payload.callId": String(call._id) });
}

/** One answer to a call, and the notice the owner got about it. */
export async function deleteApplication(application) {
  await application.deleteOne();
  await Notification.deleteMany({ type: "call_application", "payload.callId": String(application.call), "payload.actorId": String(application.applicant) });
}

