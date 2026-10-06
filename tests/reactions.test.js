import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { REACTIONS, REACTION_KEYS, checkEmoji, emojiOf } from "../utils/reactionKeys.js";
import { emptySummary, summarise } from "../utils/reactions.js";

// A fake push sender, so a push to someone's device can be seen.
const sent = [];
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, message: JSON.parse(payload) });
      return { statusCode: 201 };
    }),
  },
}));
const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${60 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, name };
}
async function befriend(a, b) {
  const sentRequest = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sentRequest.body.friendship._id}`);
}
const counts = (over = {}) => ({ like: 0, love: 0, laugh: 0, wow: 0, sad: 0, fire: 0, ...over });
const summary = (over = {}, mine = null) => ({ counts: counts(over), total: Object.values(counts(over)).reduce((a, n) => a + n, 0), mine });

describe("the six emoji", () => {
  it("are fixed, each with a name and a mark", () => {
    expect(REACTION_KEYS).toEqual(["like", "love", "laugh", "wow", "sad", "fire"]);
    expect(REACTIONS.map((r) => r.emoji)).toEqual(["👍", "❤️", "😂", "😮", "😢", "🔥"]);
    expect(emojiOf("fire")).toBe("🔥");
    expect(emojiOf("nope")).toBe("");
    for (const r of REACTIONS) expect(r.name.length).toBeGreaterThan(2);
  });

  it("are the only things a reaction can be, or null to take it away", () => {
    for (const key of REACTION_KEYS) expect(checkEmoji(key)).toEqual({ value: key });
    expect(checkEmoji(null)).toEqual({ value: null });
    for (const bad of [undefined, 1, 0, -1, true, {}, [], "", "LIKE", "👍", "like ", "constructor", "__proto__"]) expect(checkEmoji(bad).error, String(bad)).toMatch(/emoji must be one of/);
  });

  it("start every summary at nothing, separately", () => {
    const a = emptySummary();
    a.counts.like = 5;
    expect(emptySummary()).toEqual(summary());
  });
});

describe("emoji reactions on posts, notes about them, and the old likes", () => {
  let app, M, P, R;
  beforeAll(async () => {
    process.env.VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    process.env.VAPID_PRIVATE_KEY = "UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls";
    process.env.VAPID_SUBJECT = "mailto:owner@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    P = await import("../services/push.js");
    R = await import("../services/reactionMigration.js");
    M = {
      Reaction: (await import("../models/Reaction.js")).Reaction,
      MediaReaction: (await import("../models/MediaReaction.js")).MediaReaction,
      MediaItem: (await import("../models/MediaItem.js")).MediaItem,
      Post: (await import("../models/Post.js")).Post,
      Notification: (await import("../models/Notification.js")).Notification,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
      PushSubscription: (await import("../models/PushSubscription.js")).PushSubscription,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    sent.length = 0;
  });
  afterAll(async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    await clearTestDb();
    await disconnectTestDb();
  });

  const makePost = async (who, content = "A post") => (await who.agent.post("/api/posts").send({ content })).body.post;
  const addPicture = async (who) => (await who.agent.post("/api/media").send({ url: "https://images.example.com/p.jpg", type: "image" })).body.mediaItem;
  const reactTo = (kind, who, id, emoji) => who.agent.put(`/api/${kind}/${id}/reaction`).send({ emoji });
  const noteTypes = async (who) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === "reaction");

  describe("on posts", () => {
    it("start with none, and a new post says so", async () => {
      const alice = await signup(app, "alice");
      const post = await makePost(alice);
      expect(post.reactions).toEqual(summary());
    });

    it("lets people react, change their mind, and take it away, one each, and shows everyone the total and each their own", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      await befriend(alice, bobby);
      await befriend(alice, carol);
      const post = await makePost(alice);

      let res = await reactTo("posts", bobby, post.id, "love");
      expect(res.status).toBe(200);
      expect(res.body.reactions).toEqual(summary({ love: 1 }, "love"));
      await reactTo("posts", carol, post.id, "love");
      await reactTo("posts", alice, post.id, "fire"); // the author can react to their own post
      res = await reactTo("posts", bobby, post.id, "laugh");
      expect(res.body.reactions).toEqual(summary({ love: 1, laugh: 1, fire: 1 }, "laugh"));
      expect(await M.Reaction.countDocuments({ targetType: "post" })).toBe(3);

      const feedOf = async (who) => (await who.agent.get("/api/posts/feed")).body.posts.find((p) => p.id === post.id);
      expect((await feedOf(carol)).reactions).toEqual(summary({ love: 1, laugh: 1, fire: 1 }, "love"));
      expect((await feedOf(alice)).reactions.mine).toBe("fire");

      res = await reactTo("posts", bobby, post.id, null);
      expect(res.body.reactions).toEqual(summary({ love: 1, fire: 1 }, null));
      expect((await bobby.agent.get(`/api/posts/${post.id}`)).body.post.reactions).toEqual(summary({ love: 1, fire: 1 }, null));
      expect((await bobby.agent.get(`/api/posts/user/alice`)).body.posts[0].reactions.total).toBe(2);
    });

    it("checks what is sent, and who is asking", async () => {
      const alice = await signup(app, "alice");
      const post = await makePost(alice);
      for (const bad of [1, 0, "thumbs", "👍", undefined, {}]) expect((await reactTo("posts", alice, post.id, bad)).status, JSON.stringify(bad)).toBe(400);
      expect((await reactTo("posts", alice, "5f1d7f3b8f1d7f3b8f1d7f3b", "like")).status).toBe(404);
      expect((await reactTo("posts", alice, "not-an-id", "like")).status).toBe(404);
      expect((await request(app).put(`/api/posts/${post.id}/reaction`).send({ emoji: "like" })).status).toBe(401);
      expect(await M.Reaction.countDocuments()).toBe(0);
    });

    it("follows the post's own visibility: a private author's are for friends, and a block means a 404", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const post = await makePost(alice);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      expect((await reactTo("posts", bobby, post.id, "like")).status).toBe(404); // a stranger can't tell it exists
      await befriend(alice, bobby);
      expect((await reactTo("posts", bobby, post.id, "like")).status).toBe(200);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: false });
      await alice.agent.post("/api/users/carol/block");
      expect((await reactTo("posts", carol, post.id, "like")).status).toBe(404);
      await carol.agent.post("/api/users/alice/block").catch(() => {});
      expect(await M.Reaction.countDocuments()).toBe(1);
    });

    it("goes when the post goes, with the notes about it, and when either person's account goes", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      await befriend(alice, bobby);
      const first = await makePost(alice, "one");
      const second = await makePost(alice, "two");
      await reactTo("posts", bobby, first.id, "like");
      await reactTo("posts", bobby, second.id, "wow");
      expect(await noteTypes(alice)).toHaveLength(2);

      expect((await alice.agent.delete(`/api/posts/${first.id}`)).status).toBe(204);
      expect(await M.Reaction.countDocuments({ target: first.id })).toBe(0);
      expect(await noteTypes(alice)).toHaveLength(1);

      await bobby.agent.delete("/api/profiles/me").send({ password: "password123" });
      expect(await M.Reaction.countDocuments()).toBe(0);
      expect((await alice.agent.get("/api/posts/feed")).body.posts[0].reactions).toEqual(summary());

      await reactTo("posts", alice, second.id, "fire");
      await alice.agent.delete("/api/profiles/me").send({ password: "password123" });
      expect(await M.Reaction.countDocuments()).toBe(0);
    });

    it("is limited, sharing one budget with the pictures", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      await befriend(alice, bobby);
      const post = await makePost(alice);
      const picture = await addPicture(alice);
      await M.RateLimitHit.insertMany(Array.from({ length: 300 }, () => ({ key: `reaction:${bobby.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await reactTo("posts", bobby, post.id, "like")).status).toBe(429);
      expect((await reactTo("media", bobby, picture.id, "like")).status).toBe(429);
    });
  });

  describe("telling the owner", () => {
    it("says so once for each person and thing, however they change their mind, and never for your own", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      await befriend(alice, bobby);
      await befriend(alice, carol);
      const post = await makePost(alice);
      const picture = await addPicture(alice);

      await reactTo("posts", bobby, post.id, "love");
      let notes = await noteTypes(alice);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ type: "reaction", actor: { username: "bobby" }, payload: { targetType: "post", targetId: post.id, emoji: "love" } });

      await reactTo("posts", bobby, post.id, "fire"); // a different emoji
      await reactTo("posts", bobby, post.id, null); // taken away
      await reactTo("posts", bobby, post.id, "laugh"); // put back
      expect(await noteTypes(alice)).toHaveLength(1);

      await reactTo("posts", carol, post.id, "like"); // someone else
      await reactTo("media", bobby, picture.id, "wow"); // another thing
      await reactTo("posts", alice, post.id, "like"); // her own
      await reactTo("media", alice, picture.id, "like");
      notes = await noteTypes(alice);
      expect(notes).toHaveLength(3);
      expect(notes.map((n) => n.payload.targetType).sort()).toEqual(["media", "post", "post"]);
      expect(await M.Notification.countDocuments({ recipient: bobby.user.id, type: "reaction" })).toBe(0);
    });

    it("sends the owner's devices a note that says who and what, never the words of the post", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      await befriend(alice, bobby);
      const post = await makePost(alice, "my very private thoughts");
      const picture = await addPicture(alice);
      await M.PushSubscription.create({ user: alice.user.id, endpoint: "https://fcm.googleapis.com/fcm/send/alices", p256dh: KEYS.p256dh, auth: KEYS.auth });

      await reactTo("posts", bobby, post.id, "fire");
      await reactTo("media", bobby, picture.id, "love");
      await P.settlePushes();
      expect(sent).toHaveLength(2);
      expect(sent[0].message).toMatchObject({ body: "bobby reacted 🔥 to your post", url: `/posts/${post.id}` });
      expect(sent[1].message).toMatchObject({ body: "bobby reacted ❤️ to your portfolio", url: `/u/alice?piece=${picture.id}#portfolio` });
      expect(JSON.stringify(sent)).not.toMatch(/private thoughts/);

      sent.length = 0;
      await alice.agent.patch("/api/push/preferences").send({ comments: false });
      const other = await makePost(alice, "another");
      await reactTo("posts", bobby, other.id, "wow");
      await P.settlePushes();
      expect(sent).toHaveLength(0); // switched off, though the bell still has it
      expect(await M.Notification.countDocuments({ recipient: alice.user.id, type: "reaction" })).toBe(3);
    });

    it("goes when a picture is deleted", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const picture = await addPicture(alice);
      await reactTo("media", bobby, picture.id, "wow");
      expect(await noteTypes(alice)).toHaveLength(1);
      await alice.agent.delete(`/api/media/${picture.id}`);
      expect(await noteTypes(alice)).toHaveLength(0);
    });
  });

  describe("summarise", () => {
    it("is empty for nothing, and for things nobody has reacted to", async () => {
      expect((await summarise("post", [], "5f1d7f3b8f1d7f3b8f1d7f3b")).size).toBe(0);
      const out = await summarise("post", ["5f1d7f3b8f1d7f3b8f1d7f3b"], undefined);
      expect(out.get("5f1d7f3b8f1d7f3b8f1d7f3b")).toEqual(summary());
    });
  });

  describe("carrying the old likes over", () => {
    it("turns each like into a 👍, drops dislikes, leaves a reaction someone has already made, and empties the old collection", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const carol = await signup(app, "carol");
      const dave = await signup(app, "dave");
      const picture = await addPicture(alice);
      const other = await addPicture(bobby);
      const item = picture.id;
      await M.MediaReaction.insertMany([
        { item, user: bobby.user.id, value: 1 },
        { item, user: carol.user.id, value: -1 },
        { item, user: dave.user.id, value: 1 },
        { item: other.id, user: alice.user.id, value: 1 },
      ]);
      await M.Reaction.create({ targetType: "media", target: item, user: dave.user.id, emoji: "love" }); // dave changed his mind already

      expect(await R.migrateMediaReactions()).toBe(3);
      expect(await M.MediaReaction.countDocuments()).toBe(0);
      const listed = (await alice.agent.get("/api/media/user/alice")).body.media[0];
      expect(listed.reactions).toEqual(summary({ like: 1, love: 1 }, null)); // bobby's like, dave's love; carol's dislike is gone
      expect((await bobby.agent.get("/api/media/user/alice")).body.media[0].reactions.mine).toBe("like");
      expect((await dave.agent.get("/api/media/user/alice")).body.media[0].reactions.mine).toBe("love");
      expect((await alice.agent.get("/api/media/user/bobby")).body.media[0].reactions.mine).toBe("like");
    });

    it("does nothing the second time, or when there is nothing to do, and makes no notes", async () => {
      const alice = await signup(app, "alice");
      const bobby = await signup(app, "bobby");
      const picture = await addPicture(alice);
      expect(await R.migrateMediaReactions()).toBe(0);
      await M.MediaReaction.create({ item: picture.id, user: bobby.user.id, value: 1 });
      expect(await R.migrateMediaReactions()).toBe(1);
      expect(await R.migrateMediaReactions()).toBe(0);
      expect(await M.Reaction.countDocuments()).toBe(1);
      expect(await M.Notification.countDocuments({ type: "reaction" })).toBe(0);
    });

    it("copes with the same carry-over running twice at once", async () => {
      const alice = await signup(app, "alice");
      const picture = await addPicture(alice);
      const people = [];
      for (const n of ["peer1", "peer2", "peer3", "peer4"]) people.push(await signup(app, n));
      await M.MediaReaction.insertMany(people.map((p) => ({ item: picture.id, user: p.user.id, value: 1 })));
      await Promise.all([R.migrateMediaReactions(), R.migrateMediaReactions()]);
      expect(await M.Reaction.countDocuments()).toBe(4);
      expect(await M.MediaReaction.countDocuments()).toBe(0);
    });
  });
});
