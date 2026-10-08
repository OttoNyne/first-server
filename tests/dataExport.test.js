import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { buildExport, EXPORT_FORMAT } from "../services/dataExport.js";
import { pairKey } from "../models/Message.js";

describe("download my data", () => {
  let app;
  let M;

  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    const load = async (path, name) => (await import(path))[name];
    M = {
      User: await load("../models/User.js", "User"),
      Post: await load("../models/Post.js", "Post"),
      Comment: await load("../models/Comment.js", "Comment"),
      ProfileComment: await load("../models/ProfileComment.js", "ProfileComment"),
      BlogEntry: await load("../models/BlogEntry.js", "BlogEntry"),
      BlogComment: await load("../models/BlogComment.js", "BlogComment"),
      Bulletin: await load("../models/Bulletin.js", "Bulletin"),
      MediaItem: await load("../models/MediaItem.js", "MediaItem"),
      MediaComment: await load("../models/MediaComment.js", "MediaComment"),
      Album: await load("../models/Album.js", "Album"),
      Track: await load("../models/Track.js", "Track"),
      Event: await load("../models/Event.js", "Event"),
      EventRsvp: await load("../models/EventRsvp.js", "EventRsvp"),
      Group: await load("../models/Group.js", "Group"),
      GroupMembership: await load("../models/GroupMembership.js", "GroupMembership"),
      GroupTopic: await load("../models/GroupTopic.js", "GroupTopic"),
      GroupReply: await load("../models/GroupReply.js", "GroupReply"),
      GroupMessage: await load("../models/GroupMessage.js", "GroupMessage"),
      Message: await load("../models/Message.js", "Message"),
      Task: await load("../models/Task.js", "Task"),
      Friendship: await load("../models/Friendship.js", "Friendship"),
      TopFriend: await load("../models/TopFriend.js", "TopFriend"),
      Block: await load("../models/Block.js", "Block"),
      Reaction: await load("../models/Reaction.js", "Reaction"),
      Invite: await load("../models/Invite.js", "Invite"),
      UsernameHistory: await load("../models/UsernameHistory.js", "UsernameHistory"),
      PushSubscription: await load("../models/PushSubscription.js", "PushSubscription"),
      RateLimitHit: await load("../models/RateLimitHit.js", "RateLimitHit"),
    };
  });
  beforeEach(async () => {
    await clearTestDb();
  });
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const PASSWORD = "password-123";
  async function signup(name) {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({ email: `${name}@example.com`, username: name, password: PASSWORD, displayName: name });
    expect(res.status).toBe(201);
    return { agent, id: res.body.user.id };
  }
  const download = (me, body = { password: PASSWORD }) => me.agent.post("/api/profiles/me/export").send(body);

  /** A full life on the site for zoe, and things belonging to sam that must never end up in her file. */
  async function populate() {
    const zoe = await signup("zoe");
    const sam = await signup("sam");
    const old = await signup("oldfriend");
    const ids = { zoe: zoe.id, sam: sam.id };

    await M.User.updateOne({ _id: zoe.id }, { bio: "Painter and potter", mood: "busy", tags: ["art", "pots"], location: "Leeds", birthday: { month: 3, day: 9 }, "about.music": "Jazz", theme: { bgColor: "#102030", cardStyle: "glass" }, isPrivate: true });
    const post = await M.Post.create({ author: zoe.id, content: "My first post", imageUrl: "https://img.example/p.jpg" });
    const samsPost = await M.Post.create({ author: sam.id, content: "Sam's secret post" });
    await M.Comment.create({ post: samsPost._id, author: zoe.id, content: "Zoe on Sam's post" });
    await M.Comment.create({ post: post._id, author: sam.id, content: "Sam commenting on Zoe's post" });
    await M.ProfileComment.create({ profileOwner: sam.id, author: zoe.id, content: "Zoe's testimonial for Sam" });
    await M.ProfileComment.create({ profileOwner: zoe.id, author: sam.id, content: "Sam's testimonial for Zoe" });
    const entry = await M.BlogEntry.create({ author: zoe.id, title: "On clay", body: "Clay is wonderful" });
    const samsEntry = await M.BlogEntry.create({ author: sam.id, title: "Samuel's journal", body: "Sam's private thoughts" });
    await M.BlogComment.create({ entry: samsEntry._id, author: zoe.id, content: "Zoe on Sam's blog" });
    await M.BlogComment.create({ entry: entry._id, author: sam.id, content: "Sam on Zoe's blog" });
    await M.Bulletin.create({ author: zoe.id, title: "Open studio", body: "Come along", expireAt: new Date(Date.now() + 86_400_000) });
    const album = await M.Album.create({ owner: zoe.id, title: "Pots" });
    const piece = await M.MediaItem.create({ owner: zoe.id, url: "https://img.example/pot.jpg", type: "image", caption: "A blue pot", album: album._id });
    const samsPiece = await M.MediaItem.create({ owner: sam.id, url: "https://img.example/sams.jpg", type: "image", caption: "Sam's sculpture" });
    await M.MediaComment.create({ item: samsPiece._id, author: zoe.id, content: "Zoe on Sam's piece" });
    await M.MediaComment.create({ item: piece._id, author: sam.id, content: "Sam on Zoe's piece" });
    await M.Track.create({ owner: zoe.id, title: "Blue song", sourceType: "youtube", url: "https://youtu.be/abc", position: 0, profileSong: true });
    await M.Track.create({ owner: sam.id, title: "Sam's song", sourceType: "youtube", url: "https://youtu.be/def", position: 0 });
    const event = await M.Event.create({ host: zoe.id, title: "Studio night", startsAt: new Date(Date.now() + 86_400_000), expireAt: new Date(Date.now() + 5 * 86_400_000), kind: "in_person", place: "My studio", audience: "friends" });
    const samsEvent = await M.Event.create({ host: sam.id, title: "Sam's gig", startsAt: new Date(Date.now() + 86_400_000), expireAt: new Date(Date.now() + 5 * 86_400_000), kind: "online", link: "https://example.com/gig", audience: "public" });
    await M.EventRsvp.create({ event: samsEvent._id, user: zoe.id, status: "going" });
    await M.EventRsvp.create({ event: event._id, user: sam.id, status: "going" });
    const group = await M.Group.create({ name: "Potters", createdBy: sam.id });
    await M.GroupMembership.create({ group: group._id, user: zoe.id, role: "member" });
    await M.GroupMembership.create({ group: group._id, user: sam.id, role: "admin" });
    const topic = await M.GroupTopic.create({ group: group._id, author: zoe.id, title: "Best kiln?", body: "Which kiln do you use?", lastActivityAt: new Date() });
    const samsTopic = await M.GroupTopic.create({ group: group._id, author: sam.id, title: "Sam's topic", body: "Sam's topic body", lastActivityAt: new Date() });
    await M.GroupReply.create({ topic: samsTopic._id, group: group._id, author: zoe.id, body: "Zoe's reply" });
    await M.GroupReply.create({ topic: topic._id, group: group._id, author: sam.id, body: "Sam's reply to Zoe" });
    await M.GroupMessage.create({ group: group._id, sender: zoe.id, body: "Zoe in the group chat" });
    await M.GroupMessage.create({ group: group._id, sender: sam.id, body: "Sam in the group chat" });
    await M.Message.create({ sender: zoe.id, recipient: sam.id, pair: pairKey(zoe.id, sam.id), body: "Hi Sam, from Zoe" });
    await M.Message.create({ sender: sam.id, recipient: zoe.id, pair: pairKey(zoe.id, sam.id), body: "Hi Zoe, from Sam" });
    await M.Task.create({ owner: zoe.id, title: "Glaze the pots", description: "Blue", isPublic: false });
    await M.Task.create({ owner: sam.id, title: "Sam's chore" });
    await M.Friendship.create({ requester: zoe.id, addressee: sam.id, status: "accepted" });
    await M.Friendship.create({ requester: old.id, addressee: zoe.id, status: "pending" });
    await M.Friendship.create({ requester: zoe.id, addressee: old.id, status: "declined" });
    await M.TopFriend.create({ owner: zoe.id, target: sam.id, position: 0 });
    await M.Block.create({ blocker: zoe.id, blocked: old.id });
    await M.Block.create({ blocker: sam.id, blocked: zoe.id });
    await M.Reaction.create({ targetType: "post", target: samsPost._id, user: zoe.id, emoji: "love" });
    await M.Reaction.create({ targetType: "post", target: post._id, user: sam.id, emoji: "fire" });
    await M.Invite.create({ inviter: zoe.id, code: "SECRETINVITECODE123", expireAt: new Date(Date.now() + 86_400_000), uses: 2 });
    await M.UsernameHistory.create({ username: "zoe_old", user: zoe.id, expireAt: new Date(Date.now() + 86_400_000) });
    await M.PushSubscription.create({ user: zoe.id, endpoint: "https://fcm.googleapis.com/fcm/send/PRIVATEDEVICE", p256dh: "k".repeat(40), auth: "a".repeat(12) });
    return { zoe, sam, old, ids };
  }

  it("needs a sign-in and the password, and a wrong password is counted", async () => {
    expect((await request(app).post("/api/profiles/me/export").send({ password: PASSWORD })).status).toBe(401);
    const zoe = await signup("zoe");
    expect((await download(zoe, {})).status).toBe(400);
    expect((await download(zoe, { password: "" })).status).toBe(400);
    expect((await download(zoe, { password: { $ne: "" } })).status).toBe(400);
    expect((await download(zoe, { password: "x".repeat(201) })).status).toBe(400);
    const wrong = await download(zoe, { password: "not-my-password" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("Incorrect password");
    expect(wrong.headers["content-disposition"]).toBeUndefined();
    await M.RateLimitHit.insertMany(Array.from({ length: 5 }, () => ({ key: `export-password:${zoe.id}`, at: new Date(), expireAt: new Date(Date.now() + 900_000) })));
    const blocked = await download(zoe);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("is a file to save, never kept by a cache, named for the account", async () => {
    const zoe = await signup("zoe");
    const res = await download(zoe);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="creativesselect-zoe-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const parsed = JSON.parse(res.text);
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(Date.parse(parsed.exportedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("has what the person wrote and chose, in every part of the site", async () => {
    const { zoe, ids } = await populate();
    const data = JSON.parse((await download(zoe)).text);

    expect(data.account).toMatchObject({ username: "zoe", displayName: "zoe", email: "zoe@example.com", bio: "Painter and potter", mood: "busy", tags: ["art", "pots"], previousUsernames: ["zoe_old"] });
    expect(data.account.aboutMe).toMatchObject({ music: "Jazz", location: "Leeds", birthday: { month: 3, day: 9 } });
    expect(data.account.theme).toMatchObject({ bgColor: "#102030", cardStyle: "glass" });
    expect(data.account.privacy.privateProfile).toBe(true);
    expect(data.posts).toEqual([expect.objectContaining({ text: "My first post", pictureUrl: "https://img.example/p.jpg" })]);
    expect(data.comments.map((c) => c.text)).toEqual(["Zoe on Sam's post"]);
    expect(data.testimonialsYouWrote).toEqual([expect.objectContaining({ onProfileOf: "sam", text: "Zoe's testimonial for Sam" })]);
    expect(data.blogEntries).toEqual([expect.objectContaining({ title: "On clay", text: "Clay is wonderful" })]);
    expect(data.blogComments.map((c) => c.text)).toEqual(["Zoe on Sam's blog"]);
    expect(data.bulletins).toEqual([expect.objectContaining({ title: "Open studio" })]);
    expect(data.portfolio.albums.map((a) => a.title)).toEqual(["Pots"]);
    expect(data.portfolio.pieces).toEqual([expect.objectContaining({ caption: "A blue pot", url: "https://img.example/pot.jpg" })]);
    expect(data.portfolio.commentsYouWrote.map((c) => c.text)).toEqual(["Zoe on Sam's piece"]);
    expect(data.music).toEqual([expect.objectContaining({ title: "Blue song", profileSong: true })]);
    expect(data.events.hosted).toEqual([expect.objectContaining({ title: "Studio night", place: "My studio" })]);
    expect(data.events.yourAnswers).toEqual([{ event: "Sam's gig", hostedBy: "sam", answer: "going" }]);
    expect(data.groups.memberOf).toEqual([expect.objectContaining({ group: "Potters", role: "member" })]);
    expect(data.groups.topicsYouStarted).toEqual([expect.objectContaining({ group: "Potters", title: "Best kiln?" })]);
    expect(data.groups.repliesYouWrote.map((r) => r.text)).toEqual(["Zoe's reply"]);
    expect(data.groups.chatMessagesYouSent.map((m) => m.text)).toEqual(["Zoe in the group chat"]);
    expect(data.messagesYouSent).toEqual([expect.objectContaining({ to: "sam", text: "Hi Sam, from Zoe" })]);
    expect(data.tasks).toEqual([expect.objectContaining({ title: "Glaze the pots", description: "Blue", public: false })]);
    expect(data.people).toEqual({ friends: ["sam"], requestsYouSent: [], topFriends: ["sam"], blocked: ["oldfriend"] });
    expect(data.reactionsYouLeft).toEqual([expect.objectContaining({ on: "post", emoji: "love" })]);
    expect(data.inviteLinks).toEqual([expect.objectContaining({ used: 2, allowed: 10 })]);
    expect(data.cutOff).toEqual([]);
    expect(ids.zoe).toBeTruthy();
  });

  it("leaves out other people's words and everything that guards the account", async () => {
    const { zoe } = await populate();
    const res = await download(zoe);
    const raw = res.text;
    // what other people wrote
    for (const theirs of ["Sam's secret post", "Sam commenting on Zoe's post", "Sam's testimonial for Zoe", "Samuel's journal", "Sam's private thoughts", "Sam on Zoe's blog", "Sam's sculpture", "Sam on Zoe's piece", "Sam's song", "Sam's chore", "Sam's topic", "Sam's reply to Zoe", "Sam in the group chat", "Hi Zoe, from Sam"]) {
      expect(raw, theirs).not.toContain(theirs);
    }
    // what guards the account, and what belongs to the site
    for (const secret of ["passwordHash", "$2b$", "twoFactor", "recoveryHashes", "pendingSecret", "PRIVATEDEVICE", "fcm.googleapis", "SECRETINVITECODE123", "sessionsRevokedAt", "suspendedAt", "suspensionNote", "sam@example.com", "oldfriend@example.com"]) {
      expect(raw, secret).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(raw).account)).not.toContain("passwordHash");
  });

  it("shows other people only as usernames, never their email or id, and not for someone who has since left", async () => {
    const { zoe, sam } = await populate();
    await M.User.deleteOne({ _id: sam.id });
    const data = JSON.parse((await download(zoe)).text);
    expect(data.messagesYouSent[0].to).toBeNull();
    expect(data.people.friends).toEqual([null]);
    const raw = JSON.stringify(data);
    expect(raw).not.toContain(sam.id);
  });

  it("is only the signed-in person's own, whoever else has data", async () => {
    const { zoe, sam } = await populate();
    const mine = JSON.parse((await download(zoe)).text);
    const theirs = JSON.parse((await download(sam)).text);
    expect(mine.account.username).toBe("zoe");
    expect(theirs.account.username).toBe("sam");
    expect(theirs.posts.map((p) => p.text)).toEqual(["Sam's secret post"]);
    expect(theirs.messagesYouSent.map((m) => m.text)).toEqual(["Hi Zoe, from Sam"]);
    expect(JSON.stringify(theirs)).not.toContain("My first post");
    expect(JSON.stringify(theirs)).not.toContain("Hi Sam, from Zoe");
  });

  it("is limited to three a hour, so it can't be used to keep the server busy", async () => {
    const zoe = await signup("zoe");
    for (let i = 0; i < 3; i++) expect((await download(zoe)).status).toBe(200);
    const fourth = await download(zoe);
    expect(fourth.status).toBe(429);
    expect(fourth.headers["retry-after"]).toBeTruthy();
    expect(fourth.text).not.toContain("account");
    // a wrong password never uses one up
    const sam = await signup("sam");
    await download(sam, { password: "wrong-wrong" });
    for (let i = 0; i < 3; i++) expect((await download(sam)).status).toBe(200);
  });

  it("an empty account still gives a complete, valid file", async () => {
    const zoe = await signup("zoe");
    const data = JSON.parse((await download(zoe)).text);
    for (const key of ["posts", "comments", "testimonialsYouWrote", "blogEntries", "blogComments", "bulletins", "music", "messagesYouSent", "tasks", "reactionsYouLeft", "inviteLinks", "cutOff"]) expect(data[key], key).toEqual([]);
    expect(data.portfolio).toEqual({ albums: [], pieces: [], creditsYouGave: [], creditsYouAccepted: [], commentsYouWrote: [] });
    expect(data.people).toEqual({ friends: [], requestsYouSent: [], topFriends: [], blocked: [] });
    expect(data.account.twoStepSignInOn).toBe(false);
  });

  it("says that two-step sign-in is on, but nothing about how", async () => {
    const zoe = await signup("zoe");
    await M.User.updateOne({ _id: zoe.id }, { "twoFactor.enabled": true, "twoFactor.secret": "SEALEDSECRETVALUE", "twoFactor.recoveryHashes": ["a".repeat(64)] });
    const res = await download(zoe);
    expect(JSON.parse(res.text).account.twoStepSignInOn).toBe(true);
    expect(res.text).not.toContain("SEALEDSECRETVALUE");
    expect(res.text).not.toContain("a".repeat(64));
  });

  it("stops a very long section at the limit and says which one", async () => {
    const zoe = await signup("zoe");
    await M.Task.insertMany(Array.from({ length: 7 }, (_, i) => ({ owner: zoe.id, title: `Task ${i}` })));
    await M.Post.insertMany(Array.from({ length: 3 }, (_, i) => ({ author: zoe.id, content: `Post ${i}` })));
    const data = await buildExport(zoe.id, { max: 5 });
    expect(data.tasks).toHaveLength(5);
    expect(data.tasks.map((t) => t.title)).toEqual(["Task 0", "Task 1", "Task 2", "Task 3", "Task 4"]);
    expect(data.posts).toHaveLength(3);
    expect(data.cutOff).toEqual(["tasks"]);
  });

  it("gives nothing for an account that doesn't exist", async () => {
    expect(await buildExport("000000000000000000000000")).toBeNull();
  });
});
