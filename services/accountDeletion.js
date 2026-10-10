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
import { DismissedSuggestion } from "../models/DismissedSuggestion.js";
import { TrackPlay } from "../models/TrackPlay.js";
import { Notification } from "../models/Notification.js";
import { ScheduledLive } from "../models/ScheduledLive.js";
import { BlogEntry } from "../models/BlogEntry.js";
import { Bulletin } from "../models/Bulletin.js";
import { ProfileView } from "../models/ProfileView.js";
import { Album } from "../models/Album.js";
import { Credit } from "../models/Credit.js";
import { Follow } from "../models/Follow.js";
import { Save } from "../models/Save.js";
import { PollVote } from "../models/PollVote.js";
import { Mute } from "../models/Mute.js";
import { TagFollow } from "../models/TagFollow.js";
import { Project } from "../models/Project.js";
import { ProjectMessage } from "../models/ProjectMessage.js";
import { deleteProject, removeMember } from "./projects.js";
import { ProcessStep } from "../models/ProcessStep.js";
import { Critique } from "../models/Critique.js";
import { ScheduledPost } from "../models/ScheduledPost.js";
import { removeScheduledPost } from "./scheduledPosts.js";
import { CritiqueNote } from "../models/CritiqueNote.js";
import { deleteCritique } from "./removal.js";
import { Call } from "../models/Call.js";
import { CallApplication } from "../models/CallApplication.js";
import { ChallengeEntry } from "../models/ChallengeEntry.js";
import { WorkRequest } from "../models/WorkRequest.js";
import { GroupTopic } from "../models/GroupTopic.js";
import { GroupReply } from "../models/GroupReply.js";
import { Invite } from "../models/Invite.js";
import { Block } from "../models/Block.js";
import { Report } from "../models/Report.js";
import { Task } from "../models/Task.js";
import { UsernameHistory } from "../models/UsernameHistory.js";
import { Reaction } from "../models/Reaction.js";
import { MediaComment } from "../models/MediaComment.js";
import { BlogComment } from "../models/BlogComment.js";
import { releasePictures } from "./commentPictures.js";
import { Event } from "../models/Event.js";
import { EventRsvp } from "../models/EventRsvp.js";
import { Message } from "../models/Message.js";
import { GroupMessage } from "../models/GroupMessage.js";
import { PasswordReset } from "../models/PasswordReset.js";
import { LiveSession, LiveListener, LiveSignal, LiveComment } from "../models/Live.js";
import { deleteSfuRoom } from "./livekit.js";
import { EmailVerification } from "../models/EmailVerification.js";
import { deleteAllStoredAssets } from "./storedAssets.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { Session } from "../models/Session.js";
import { EmailChange } from "../models/EmailChange.js";
import { Passkey } from "../models/Passkey.js";
import { PasskeyChallenge } from "../models/PasskeyChallenge.js";

// Groups the user created: an empty group is deleted; otherwise it is handed
// to its longest-standing other member (promoted to admin) so other people's
// group isn't destroyed by one person leaving.
async function releaseGroups(userId) {
  const groups = await Group.find({ createdBy: userId });
  for (const group of groups) {
    const successor = await GroupMembership.findOne({ group: group._id, user: { $ne: userId } }).sort("joinedAt");
    if (!successor) {
      await GroupMembership.deleteMany({ group: group._id });
      await GroupMessage.deleteMany({ group: group._id });
      await GroupReply.deleteMany({ group: group._id });
      await GroupTopic.deleteMany({ group: group._id });
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
  const comments = await Comment.find({ $or: [{ author: id }, { post: { $in: postIds } }] }).select("_id author imageUrl");
  const profileComments = await ProfileComment.find({ $or: [{ profileOwner: id }, { author: id }] }).select("_id author imageUrl");

  await Comment.deleteMany({ _id: { $in: comments.map((c) => c._id) } });
  await ProfileComment.deleteMany({ _id: { $in: profileComments.map((c) => c._id) } });
  // pictures other people put in comments that go with this account were their files: let them go too (this account's own go with its ledger below)
  await releasePictures([...comments, ...profileComments].filter((c) => String(c.author) !== String(id)));
  await Post.deleteMany({ author: id });
  const blogIds = (await BlogEntry.find({ author: id }).select("_id")).map((e) => e._id);
  await BlogEntry.deleteMany({ author: id });
  const blogComments = await BlogComment.find({ $or: [{ author: id }, { entry: { $in: blogIds } }] }).select("_id author imageUrl");
  await BlogComment.deleteMany({ _id: { $in: blogComments.map((c) => c._id) } });
  await releasePictures(blogComments.filter((c) => String(c.author) !== String(id)));
  const bulletinIds = (await Bulletin.find({ author: id }).select("_id")).map((b) => b._id);
  await Bulletin.deleteMany({ author: id });
  await ProfileView.deleteMany({ $or: [{ owner: id }, { viewer: id }] });

  await Friendship.deleteMany({ $or: [{ requester: id }, { addressee: id }] });
  await TopFriend.deleteMany({ $or: [{ owner: id }, { target: id }] });
  await DismissedSuggestion.deleteMany({ $or: [{ owner: id }, { target: id }] });
  await GroupMembership.deleteMany({ user: id });
  await Block.deleteMany({ $or: [{ blocker: id }, { blocked: id }] });
  // Reactions on their pictures, and reactions they left on others'.
  const mediaIds = (await MediaItem.find({ owner: id }).select("_id")).map((m) => m._id);
  await Reaction.deleteMany({ $or: [{ user: id }, { targetType: "media", target: { $in: mediaIds } }, { targetType: "post", target: { $in: postIds } }] });
  // Comments they left on others' pieces, and everyone's comments on theirs.
  const mediaComments = await MediaComment.find({ $or: [{ author: id }, { item: { $in: mediaIds } }] }).select("_id author imageUrl");
  await MediaComment.deleteMany({ _id: { $in: mediaComments.map((c) => c._id) } });
  await releasePictures(mediaComments.filter((c) => String(c.author) !== String(id)));
  await Credit.deleteMany({ $or: [{ owner: id }, { person: id }] });
  await Follow.deleteMany({ $or: [{ follower: id }, { following: id }] });
  await Save.deleteMany({ $or: [{ user: id }, { targetType: "post", target: { $in: postIds } }, { targetType: "piece", target: { $in: mediaIds } }] });
  // project rooms: the ones they own go, in the others they simply leave and what they wrote goes with them
  for (const room of await Project.find({ owner: id })) await deleteProject(room);
  for (const room of await Project.find({ members: id })) await removeMember(room, id);
  const roomMessages = await ProjectMessage.find({ author: id });
  await ProjectMessage.deleteMany({ author: id });
  await releasePictures(roomMessages);
  // posts they asked to be published later never will be
  for (const waiting of await ScheduledPost.find({ author: id })) await removeScheduledPost(waiting);
  // feedback: the requests they asked (with every note on them) and the notes they wrote on other people's
  for (const request of await Critique.find({ owner: id })) await deleteCritique(request);
  const notesWritten = await CritiqueNote.find({ author: id }).select("critique");
  await CritiqueNote.deleteMany({ author: id });
  await Notification.deleteMany({ type: "critique_note", "payload.critiqueId": { $in: notesWritten.map((n) => String(n.critique)) }, "payload.actorId": String(id) });
  await ProcessStep.deleteMany({ owner: id });
  const callIds = (await Call.find({ owner: id }).select("_id")).map((c) => c._id);
  await CallApplication.deleteMany({ $or: [{ applicant: id }, { call: { $in: callIds } }] });
  await Call.deleteMany({ owner: id });
  await TagFollow.deleteMany({ user: id });
  await Mute.deleteMany({ $or: [{ user: id }, { muted: id }] });
  await PollVote.deleteMany({ $or: [{ user: id }, { post: { $in: postIds } }] });
  await ChallengeEntry.deleteMany({ user: id });
  await WorkRequest.deleteMany({ $or: [{ from: id }, { to: id }] });
  await MediaItem.deleteMany({ owner: id });
  await Album.deleteMany({ owner: id });
  // Events they organised (with every answer to them), and their answers to other people's.
  const eventIds = (await Event.find({ host: id }).select("_id")).map((e) => e._id);
  await EventRsvp.deleteMany({ $or: [{ user: id }, { event: { $in: eventIds } }] });
  await Event.deleteMany({ host: id });
  // Invite links they made, and their name on other people's lists of who came in through a link.
  await Invite.deleteMany({ inviter: id });
  await Invite.updateMany({ "joined.user": id }, { $pull: { joined: { user: id } } });
  // Their songs, the record of who played them, and the plays they made of other people's.
  const trackIds = (await Track.find({ owner: id }).select("_id")).map((t) => t._id);
  await TrackPlay.deleteMany({ $or: [{ listener: id }, { track: { $in: trackIds } }] });
  await Track.deleteMany({ owner: id });
  await Task.deleteMany({ owner: id });
  // Messages they sent or received (the other person's copy is the same document).
  await Message.deleteMany({ $or: [{ sender: id }, { recipient: id }] });
  await GroupMessage.deleteMany({ sender: id });
  // Their topics (with every reply in them) and their replies in other people's topics; reply counts are put right afterwards.
  const topicIds = (await GroupTopic.find({ author: id }).select("_id")).map((t) => t._id);
  const replyIds = (await GroupReply.find({ $or: [{ author: id }, { topic: { $in: topicIds } }] }).select("_id")).map((r) => r._id);
  await GroupReply.deleteMany({ topic: { $in: topicIds } });
  await GroupTopic.deleteMany({ author: id });
  const touched = await GroupReply.distinct("topic", { author: id });
  await GroupReply.deleteMany({ author: id });
  for (const topic of touched) await GroupTopic.updateOne({ _id: topic }, { $set: { replyCount: await GroupReply.countDocuments({ topic }) } });
  await PasswordReset.deleteMany({ user: id });
  await EmailVerification.deleteMany({ user: id });
  // Voice lives: ones they hosted (with everything in them), and their part in others.
  const hostedSessions = await LiveSession.find({ host: id }).select("_id mode");
  const hosted = hostedSessions.map((s) => s._id);
  // a live that runs through a media server has a room there too
  await Promise.all(hostedSessions.filter((s) => s.mode === "sfu").map((s) => deleteSfuRoom(String(s._id))));
  await Promise.all([
    LiveListener.deleteMany({ $or: [{ session: { $in: hosted } }, { user: id }] }),
    LiveSignal.deleteMany({ $or: [{ session: { $in: hosted } }, { from: id }, { to: id }] }),
    LiveComment.deleteMany({ $or: [{ session: { $in: hosted } }, { user: id }] }),
  ]);
  await LiveSession.deleteMany({ host: id });
  // Lives they planned (and the announcements of them), and their requests to be reminded of other people's.
  await ScheduledLive.deleteMany({ host: id });
  await ScheduledLive.updateMany({ reminders: id }, { $pull: { reminders: id } });
  await UsernameHistory.deleteMany({ user: id });

  // Notifications addressed to them, and ones they caused (actorId was stored
  // as either a string or an ObjectId depending on the route that created it).
  await Notification.deleteMany({ $or: [{ recipient: id }, { "payload.actorId": { $in: [String(id), id] } }] });
  await PushSubscription.deleteMany({ user: id }); // the devices that were getting their notifications
  await Session.deleteMany({ user: id }); // and the devices that were signed in
  await Passkey.deleteMany({ user: id });
  await PasskeyChallenge.deleteMany({ user: id });
  await EmailChange.deleteMany({ user: id }); // a change of email in progress, or the way back from one

  // Their reports, and reports about them or their content.
  const targetIds = [id, ...postIds, ...comments.map((c) => c._id), ...profileComments.map((c) => c._id), ...mediaComments.map((c) => c._id), ...blogComments.map((c) => c._id), ...eventIds, ...blogIds, ...bulletinIds, ...topicIds, ...replyIds];
  await Report.deleteMany({ $or: [{ reporter: id }, { targetId: { $in: targetIds } }] });

  const filesRemoved = await deleteAllStoredAssets(id);
  await User.deleteOne({ _id: id });
  return { filesRemoved };
}
