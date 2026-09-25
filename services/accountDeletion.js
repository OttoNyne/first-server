import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { ProfileComment } from "../models/ProfileComment.js";
import { Friendship } from "../models/Friendship.js";
import { TopFriend } from "../models/TopFriend.js";
import { Group } from "../models/Group.js";
import { GroupMembership } from "../models/GroupMembership.js";
import { MediaItem } from "../models/MediaItem.js";
import { Track } from "../models/Track.js";
import { Notification } from "../models/Notification.js";
import { Block } from "../models/Block.js";
import { Report } from "../models/Report.js";
import { Task } from "../models/Task.js";
import { UsernameHistory } from "../models/UsernameHistory.js";
import { MediaReaction } from "../models/MediaReaction.js";
import { deleteAllStoredAssets } from "./storedAssets.js";

// Groups the user created: an empty group is deleted; otherwise it is handed
// to its longest-standing other member (promoted to admin) so other people's
// group isn't destroyed by one person leaving.
async function releaseGroups(userId) {
  const groups = await Group.find({ createdBy: userId });
  for (const group of groups) {
    const successor = await GroupMembership.findOne({ group: group._id, user: { $ne: userId } }).sort("joinedAt");
    if (!successor) {
      await GroupMembership.deleteMany({ group: group._id });
      await group.deleteOne();
      continue;
    }
    successor.role = "admin";
    await successor.save();
    group.createdBy = successor.user;
    await group.save();
  }
}

// Permanently removes a user and everything that belongs to them. Order
// matters only in that the files on Cloudinary are removed while the ledger
// that lists them still exists, and the User document goes last so a failure
// partway leaves an account that can simply retry the deletion.
export async function deleteAccount(userId) {
  const id = new mongoose.Types.ObjectId(userId);

  await releaseGroups(id);

  const posts = await Post.find({ author: id }).select("_id");
  const postIds = posts.map((p) => p._id);
  const comments = await Comment.find({ $or: [{ author: id }, { post: { $in: postIds } }] }).select("_id");
  const profileComments = await ProfileComment.find({ $or: [{ profileOwner: id }, { author: id }] }).select("_id");

  await Comment.deleteMany({ _id: { $in: comments.map((c) => c._id) } });
  await ProfileComment.deleteMany({ _id: { $in: profileComments.map((c) => c._id) } });
  await Post.deleteMany({ author: id });

  await Friendship.deleteMany({ $or: [{ requester: id }, { addressee: id }] });
  await TopFriend.deleteMany({ $or: [{ owner: id }, { target: id }] });
  await GroupMembership.deleteMany({ user: id });
  await Block.deleteMany({ $or: [{ blocker: id }, { blocked: id }] });
  // Reactions on their pictures, and reactions they left on others'.
  const mediaIds = (await MediaItem.find({ owner: id }).select("_id")).map((m) => m._id);
  await MediaReaction.deleteMany({ $or: [{ user: id }, { item: { $in: mediaIds } }] });
  await MediaItem.deleteMany({ owner: id });
  await Track.deleteMany({ owner: id });
  await Task.deleteMany({ owner: id });
  await UsernameHistory.deleteMany({ user: id });

  // Notifications addressed to them, and ones they caused (actorId was stored
  // as either a string or an ObjectId depending on the route that created it).
  await Notification.deleteMany({ $or: [{ recipient: id }, { "payload.actorId": { $in: [String(id), id] } }] });

  // Their reports, and reports about them or their content.
  const targetIds = [id, ...postIds, ...comments.map((c) => c._id), ...profileComments.map((c) => c._id)];
  await Report.deleteMany({ $or: [{ reporter: id }, { targetId: { $in: targetIds } }] });

  const filesRemoved = await deleteAllStoredAssets(id);
  await User.deleteOne({ _id: id });
  return { filesRemoved };
}
