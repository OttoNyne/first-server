import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { ProfileComment } from "../models/ProfileComment.js";
import { BlogEntry } from "../models/BlogEntry.js";
import { BlogComment } from "../models/BlogComment.js";
import { Bulletin } from "../models/Bulletin.js";
import { MediaItem } from "../models/MediaItem.js";
import { MediaComment } from "../models/MediaComment.js";
import { Album } from "../models/Album.js";
import { Track } from "../models/Track.js";
import { Event } from "../models/Event.js";
import { EventRsvp } from "../models/EventRsvp.js";
import { Group } from "../models/Group.js";
import { GroupMembership } from "../models/GroupMembership.js";
import { GroupTopic } from "../models/GroupTopic.js";
import { GroupReply } from "../models/GroupReply.js";
import { GroupMessage } from "../models/GroupMessage.js";
import { Message } from "../models/Message.js";
import { Task } from "../models/Task.js";
import { Friendship } from "../models/Friendship.js";
import { TopFriend } from "../models/TopFriend.js";
import { Block } from "../models/Block.js";
import { Reaction } from "../models/Reaction.js";
import { ScheduledLive } from "../models/ScheduledLive.js";
import { Invite } from "../models/Invite.js";
import { UsernameHistory } from "../models/UsernameHistory.js";
import { languageOf } from "../utils/languages.js";
import { Credit } from "../models/Credit.js";

// "Download my data": everything a person has written or chosen on the site, as one readable file.
//
// What is included is decided here, field by field, never by copying a whole record: a new field on a model is not exported (or
// shown to anyone) until someone adds it on purpose. What is deliberately left out:
//   - other people's words: messages and comments they wrote to or about this person, testimonials left on their profile. (Their
//     own words to others are included, with the other person's username so it is clear who it was to.)
//   - anything that guards the account: the password hash, the two-step secret and recovery codes, sign-ins, push device addresses.
//   - site records about them that they didn't write: reports, moderation notes, rate-limit counts, who viewed their profile.
export const EXPORT_FORMAT = "creativesselect-export-1";
// A section never grows without end: past this many rows it stops, and says so.
export const MAX_PER_SECTION = 5000;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const text = (s) => (typeof s === "string" ? s : "");

// The one sentence in the file written for a person (the names of the fields stay English: the file is meant to be read by programs too).
const ABOUT = {
  en: "Everything you have written or chosen on CreativesSelect. Other people's words to you (messages, comments on your posts, testimonials on your profile) are not included, because they are theirs; your own words to them are, with their username. Nothing that protects your account (password, two-step secret, sign-ins) is included.",
  es: "Todo lo que has escrito o elegido en CreativesSelect. Las palabras de otras personas dirigidas a ti (mensajes, comentarios en tus publicaciones, testimonios en tu perfil) no se incluyen, porque son suyas; tus propias palabras para ellas sí, con su nombre de usuario. No se incluye nada de lo que protege tu cuenta (contraseña, secreto de dos pasos, inicios de sesión).",
  ar: "كل ما كتبته أو اخترته في CreativesSelect. لا يتضمن الملف كلمات الآخرين الموجهة إليك (الرسائل والتعليقات على منشوراتك والشهادات في ملفك الشخصي) لأنها ملك لهم؛ أما كلماتك أنت إليهم فمضمّنة مع اسم المستخدم الخاص بهم. ولا يتضمن الملف أي شيء يحمي حسابك (كلمة المرور وسر الخطوتين وعمليات تسجيل الدخول).",
};

export async function buildExport(userId, { max = MAX_PER_SECTION, now = new Date() } = {}) {
  const id = new mongoose.Types.ObjectId(userId);
  const user = await User.findById(id).lean();
  if (!user) return null;

  const truncated = [];
  /** Reads up to `max` rows (oldest first), noting if there were more. */
  async function rows(name, query) {
    const found = await query.sort({ _id: 1 }).limit(max + 1).lean();
    if (found.length > max) truncated.push(name);
    return found.slice(0, max);
  }

  // Other people appear only as usernames, looked up in one go at the end.
  const wanted = new Set();
  const who = (value) => {
    if (value) wanted.add(String(value));
    return value ? String(value) : null;
  };
  const resolved = new Map();
  const name = (value) => (value ? (resolved.get(String(value)) ?? null) : null);

  const posts = await rows("posts", Post.find({ author: id }));
  const comments = await rows("comments", Comment.find({ author: id }));
  const testimonials = await rows("testimonialsWritten", ProfileComment.find({ author: id }));
  const blogEntries = await rows("blogEntries", BlogEntry.find({ author: id }));
  const blogComments = await rows("blogComments", BlogComment.find({ author: id }));
  const bulletins = await rows("bulletins", Bulletin.find({ author: id }));
  const media = await rows("media", MediaItem.find({ owner: id }));
  const mediaComments = await rows("mediaComments", MediaComment.find({ author: id }));
  // the credits you gave on your pieces, and the ones you said yes to on other people's
  const creditsGiven = await rows("creditsGiven", Credit.find({ owner: id }));
  const creditsAccepted = await rows("creditsAccepted", Credit.find({ person: id, status: "accepted" }));
  const creditNames = new Map((await User.find({ _id: { $in: [...creditsGiven.map((c) => c.person), ...creditsAccepted.map((c) => c.owner)] } }).select("username").lean()).map((u) => [String(u._id), u.username]));
  const albums = await rows("albums", Album.find({ owner: id }));
  const tracks = await rows("tracks", Track.find({ owner: id }));
  const events = await rows("events", Event.find({ host: id }));
  const rsvps = await rows("eventAnswers", EventRsvp.find({ user: id }));
  const plannedLives = await rows("plannedLives", ScheduledLive.find({ host: id }));
  const memberships = await rows("groups", GroupMembership.find({ user: id }));
  const topics = await rows("groupTopics", GroupTopic.find({ author: id }));
  const replies = await rows("groupReplies", GroupReply.find({ author: id }));
  const groupMessages = await rows("groupMessages", GroupMessage.find({ sender: id }));
  const messages = await rows("messages", Message.find({ sender: id }));
  const tasks = await rows("tasks", Task.find({ owner: id }));
  const friendships = await rows("friends", Friendship.find({ $or: [{ requester: id }, { addressee: id }] }));
  const topFriends = await rows("topFriends", TopFriend.find({ owner: id }));
  const blocks = await rows("blocked", Block.find({ blocker: id }));
  const reactions = await rows("reactions", Reaction.find({ user: id }));
  const invites = await rows("invites", Invite.find({ inviter: id }));
  const oldNames = await rows("previousUsernames", UsernameHistory.find({ user: id }));

  // Who and what the things above point at, by name.
  const groupIds = [...new Set([...memberships, ...topics, ...replies, ...groupMessages].map((r) => String(r.group)))];
  const groups = await Group.find({ _id: { $in: groupIds } }).select("name").lean();
  const groupName = new Map(groups.map((g) => [String(g._id), g.name]));
  const eventIds = rsvps.map((r) => r.event);
  const rsvpEvents = await Event.find({ _id: { $in: eventIds } }).select("title host").lean();
  const eventInfo = new Map(rsvpEvents.map((e) => [String(e._id), e]));

  const out = {
    format: EXPORT_FORMAT,
    exportedAt: iso(now),
    about: ABOUT[languageOf(user)],
    account: {
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      emailVerified: Boolean(user.emailVerified),
      joined: iso(user.createdAt),
      bio: user.bio ?? "",
      mood: user.mood ?? "",
      listeningTo: user.listeningTo ?? "",
      tags: user.tags ?? [],
      aboutMe: {
        interests: text(user.about?.interests),
        music: text(user.about?.music),
        movies: text(user.about?.movies),
        books: text(user.about?.books),
        meet: text(user.about?.meet),
        location: text(user.location),
        locationShownTo: user.locationAudience ?? "friends",
        birthday: user.birthday?.month && user.birthday?.day ? { month: user.birthday.month, day: user.birthday.day } : null,
      },
      avatarUrl: user.avatarUrl ?? null,
      wallpaper: { url: user.wallpaperUrl ?? null, type: user.wallpaperType ?? "image", position: user.wallpaperPosition ?? null, motion: user.wallpaperMotion ?? "none" },
      theme: { ...(user.theme ?? {}) },
      sectionOrder: user.sectionOrder ?? [],
      hiddenSections: user.hiddenSections ?? [],
      privacy: { privateProfile: Boolean(user.isPrivate), showOnlineStatus: user.showActivity !== false, showConnections: user.showConnections !== false, profileViewsOn: user.profileViews === true },
      notificationChoices: { ...(user.pushPrefs ?? {}) },
      csVerified: Boolean(user.csVerifiedByAdmin || user.csVerifiedEarned),
      twoStepSignInOn: Boolean(user.twoFactor?.enabled),
      previousUsernames: oldNames.map((o) => o.username),
    },
    posts: posts.map((p) => ({ id: String(p._id), text: text(p.content), pictureUrl: p.imageUrl ?? null, madeWithAi: Boolean(p.isAiText || p.isAiImage), posted: iso(p.createdAt), edited: iso(p.editedAt) })),
    comments: comments.map((c) => ({ id: String(c._id), onPost: String(c.post), text: text(c.content), pictureUrl: c.imageUrl ?? null, posted: iso(c.createdAt), edited: iso(c.editedAt) })),
    testimonialsYouWrote: testimonials.map((c) => ({ id: String(c._id), onProfileOf: who(c.profileOwner), text: text(c.content), pictureUrl: c.imageUrl ?? null, posted: iso(c.createdAt), edited: iso(c.editedAt) })),
    blogEntries: blogEntries.map((b) => ({ id: String(b._id), title: text(b.title), text: text(b.body), posted: iso(b.createdAt), edited: iso(b.updatedAt) })),
    blogComments: blogComments.map((c) => ({ id: String(c._id), onEntry: String(c.entry), text: text(c.content), pictureUrl: c.imageUrl ?? null, posted: iso(c.createdAt), edited: iso(c.editedAt) })),
    bulletins: bulletins.map((b) => ({ id: String(b._id), title: text(b.title), text: text(b.body), posted: iso(b.createdAt), expires: iso(b.expireAt) })),
    portfolio: {
      albums: albums.map((a) => ({ id: String(a._id), title: text(a.title) })),
      pieces: media.map((m) => ({ id: String(m._id), type: m.type, url: m.url, caption: text(m.caption), madeWithAi: Boolean(m.isAiImage), album: m.album ? String(m.album) : null, added: iso(m.createdAt) })),
      creditsYouGave: creditsGiven.map((c) => ({ onPiece: String(c.item), person: creditNames.get(String(c.person)) ?? null, role: text(c.role), accepted: c.status === "accepted", added: iso(c.createdAt) })),
      creditsYouAccepted: creditsAccepted.map((c) => ({ onPiece: String(c.item), pieceOf: creditNames.get(String(c.owner)) ?? null, role: text(c.role), added: iso(c.createdAt) })),
      commentsYouWrote: mediaComments.map((c) => ({ id: String(c._id), onPiece: String(c.item), text: text(c.content), pictureUrl: c.imageUrl ?? null, posted: iso(c.createdAt) })),
    },
    music: tracks.map((t) => ({ id: String(t._id), title: text(t.title), artist: text(t.artist), source: t.sourceType, url: t.url, position: t.position, profileSong: Boolean(t.profileSong), added: iso(t.createdAt) })),
    events: {
      hosted: events.map((e) => ({ id: String(e._id), title: text(e.title), description: text(e.description), starts: iso(e.startsAt), ends: iso(e.endsAt), kind: e.kind, place: text(e.place), link: text(e.link), shownTo: e.audience })),
      yourAnswers: rsvps.map((r) => ({ event: eventInfo.get(String(r.event))?.title ?? null, hostedBy: who(eventInfo.get(String(r.event))?.host), answer: r.status })),
    },
    plannedLives: plannedLives.map((l) => ({ id: String(l._id), title: text(l.title), starts: iso(l.startsAt), status: l.status })),
    groups: {
      memberOf: memberships.map((m) => ({ group: groupName.get(String(m.group)) ?? null, role: m.role, joined: iso(m.joinedAt ?? m.createdAt) })),
      topicsYouStarted: topics.map((t) => ({ id: String(t._id), group: groupName.get(String(t.group)) ?? null, title: text(t.title), text: text(t.body), posted: iso(t.createdAt) })),
      repliesYouWrote: replies.map((r) => ({ id: String(r._id), group: groupName.get(String(r.group)) ?? null, text: text(r.body), posted: iso(r.createdAt) })),
      chatMessagesYouSent: groupMessages.map((m) => ({ group: groupName.get(String(m.group)) ?? null, text: text(m.body), sent: iso(m.createdAt) })),
    },
    messagesYouSent: messages.map((m) => ({ to: who(m.recipient), text: text(m.body), sent: iso(m.createdAt), edited: iso(m.editedAt) })),
    tasks: tasks.map((t) => ({ id: String(t._id), title: text(t.title), description: text(t.description), public: Boolean(t.isPublic), done: Boolean(t.done), priority: t.priority ?? null, due: iso(t.dueDate) })),
    people: {
      friends: friendships.filter((f) => f.status === "accepted").map((f) => who(String(f.requester) === String(id) ? f.addressee : f.requester)),
      requestsYouSent: friendships.filter((f) => f.status === "pending" && String(f.requester) === String(id)).map((f) => who(f.addressee)),
      topFriends: [...topFriends].sort((a, b) => a.position - b.position).map((t) => who(t.target)),
      blocked: blocks.map((b) => who(b.blocked)),
    },
    reactionsYouLeft: reactions.map((r) => ({ on: r.targetType, id: String(r.target), emoji: r.emoji })),
    inviteLinks: invites.map((i) => ({ created: iso(i.createdAt), expires: iso(i.expireAt), allowed: i.maxUses, used: i.uses, switchedOff: Boolean(i.revokedAt) })),
    // Sections that were cut off for being very long, if any.
    cutOff: truncated,
  };

  // Turn the ids collected above into usernames (one lookup; a person who has since left shows as null).
  const named = await User.find({ _id: { $in: [...wanted] } }).select("username").lean();
  for (const u of named) resolved.set(String(u._id), u.username);
  const swap = (value) => (typeof value === "string" && wanted.has(value) ? name(value) : value);
  out.testimonialsYouWrote.forEach((t) => (t.onProfileOf = swap(t.onProfileOf)));
  out.events.yourAnswers.forEach((e) => (e.hostedBy = swap(e.hostedBy)));
  out.messagesYouSent.forEach((m) => (m.to = swap(m.to)));
  out.people.friends = out.people.friends.map(swap);
  out.people.requestsYouSent = out.people.requestsYouSent.map(swap);
  out.people.topFriends = out.people.topFriends.map(swap);
  out.people.blocked = out.people.blocked.map(swap);
  return out;
}
