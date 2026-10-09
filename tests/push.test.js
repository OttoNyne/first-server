import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { CATEGORY_NAMES, PUSH_CATEGORIES, categoryOf, checkPrefs, checkSubscription, isPushServiceHost } from "../utils/pushInput.js";

// A fake push sender, so what would be sent can be seen (nothing leaves the machine).
const sent = [];
let failWith = null;
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub, payload, options) => {
      if (failWith) throw Object.assign(new Error("push failed"), failWith(sub));
      sent.push({ endpoint: sub.endpoint, message: JSON.parse(payload), options });
      return { statusCode: 201 };
    }),
  },
}));

const KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const chrome = (id = "abc123") => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: KEYS });

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${40 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, name };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("what a device may tell us", () => {
  it("accepts the addresses of the browsers' own push services", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://updates-autopush.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QAbc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) expect(checkSubscription({ endpoint, keys: KEYS }).value?.endpoint, endpoint).toBeTruthy();
  });

  it("refuses any other address, so a device can't make this server send requests anywhere it likes", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc", // not https
      "https://evil.example.com/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example.com/x",
      "https://evil.fcm.googleapis.com/x",
      "https://notfcm.googleapis.com/x",
      "https://push.apple.com/x", // not a subdomain
      "https://x.notify.windows.com.evil.com/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest/meta-data",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pass@fcm.googleapis.com/x",
      "ftp://fcm.googleapis.com/x",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) expect(checkSubscription({ endpoint, keys: KEYS }).error, endpoint).toBeTruthy();
    expect(isPushServiceHost("FCM.GOOGLEAPIS.COM")).toBe(true);
    expect(isPushServiceHost("fcm.googleapis.com.")).toBe(false);
  });

  it("needs the two keys, in the form browsers make them, and keeps everything small", () => {
    const ok = chrome();
    expect(checkSubscription(ok).value).toEqual({ endpoint: ok.endpoint, p256dh: KEYS.p256dh, auth: KEYS.auth });
    for (const bad of [undefined, null, 5, "x", {}, { endpoint: ok.endpoint }, { endpoint: ok.endpoint, keys: {} }, { endpoint: ok.endpoint, keys: { p256dh: KEYS.p256dh } }, { endpoint: ok.endpoint, keys: { p256dh: 5, auth: 5 } }, { endpoint: ok.endpoint, keys: { p256dh: "<script>".repeat(5), auth: KEYS.auth } }, { endpoint: ok.endpoint, keys: { p256dh: KEYS.p256dh, auth: "short" } }, { endpoint: `https://fcm.googleapis.com/${"a".repeat(800)}`, keys: KEYS }, { endpoint: ok.endpoint, keys: { p256dh: "A".repeat(300), auth: KEYS.auth } }]) {
      expect(checkSubscription(bad).error, JSON.stringify(bad)?.slice(0, 60)).toBeTruthy();
    }
  });

  it("has six switches that between them cover every kind of notification once", () => {
    expect(CATEGORY_NAMES).toEqual(["messages", "friends", "comments", "events", "live", "updates"]);
    const all = Object.values(PUSH_CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(categoryOf("message")).toBe("messages");
    expect(categoryOf("blog_comment")).toBe("comments");
    expect(categoryOf("live_started")).toBe("live");
    expect(categoryOf("not_a_type")).toBeNull();
  });

  it("takes changes to the switches only as true or false, for kinds that exist", () => {
    expect(checkPrefs({ messages: false, live: true }).value).toEqual({ messages: false, live: true });
    for (const bad of [undefined, null, [], "x", {}, { messages: "no" }, { nope: true }, { messages: 0 }, { __proto__: null, messages: null }]) expect(checkPrefs(bad).error).toBeTruthy();
  });
});

describe("push notifications", () => {
  let app, M, P;
  beforeAll(async () => {
    process.env.VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    process.env.VAPID_PRIVATE_KEY = "UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls";
    process.env.VAPID_SUBJECT = "mailto:owner@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    P = await import("../services/push.js");
    M = {
      User: (await import("../models/User.js")).User,
      PushSubscription: (await import("../models/PushSubscription.js")).PushSubscription,
      Notification: (await import("../models/Notification.js")).Notification,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    sent.length = 0;
    failWith = null;
    process.env.VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
  });
  afterAll(async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    await clearTestDb();
    await disconnectTestDb();
  });

  const on = (who, sub = chrome()) => who.agent.post("/api/push/subscribe").send({ subscription: sub });
  const status = async (who, endpoint) => (await who.agent.get(`/api/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`)).body;
  const settle = () => P.settlePushes();

  describe("turning it on", () => {
    it("is for signed-in people only", async () => {
      for (const [method, path] of [["get", "/key"], ["get", "/status"], ["post", "/subscribe"], ["post", "/unsubscribe"], ["patch", "/preferences"], ["post", "/test"]]) {
        expect((await request(app)[method](`/api/push${path}`).send({})).status, path).toBe(401);
      }
    });

    it("gives the public key a device needs, and says plainly when the site can't send them", async () => {
      const me = await signup(app, "mimi");
      expect((await me.agent.get("/api/push/key")).body).toEqual({ enabled: true, publicKey: process.env.VAPID_PUBLIC_KEY });
      expect((await status(me)).enabled).toBe(true);
      process.env.VAPID_PUBLIC_KEY = "";
      expect((await me.agent.get("/api/push/key")).body).toEqual({ enabled: false, publicKey: null });
      expect((await on(me)).status).toBe(503);
      expect((await me.agent.post("/api/push/test")).status).toBe(503);
      expect((await status(me)).enabled).toBe(false);
    });

    it("signs a device up, and knows which device is this one", async () => {
      const me = await signup(app, "mimi");
      const res = await on(me, chrome("one"));
      expect(res.status).toBe(201);
      const there = await status(me, chrome("one").endpoint);
      expect(there).toMatchObject({ devices: 1, thisDevice: true });
      expect((await status(me, chrome("another").endpoint)).thisDevice).toBe(false);
      expect((await status(me)).thisDevice).toBe(false);
      expect(await on(me, chrome("one"))).toHaveProperty("status", 201); // again: the same device, not a second
      expect((await status(me)).devices).toBe(1);
    });

    it("refuses what isn't a real subscription, with the reason", async () => {
      const me = await signup(app, "mimi");
      for (const bad of [undefined, {}, { endpoint: "https://evil.example.com/x", keys: KEYS }, { endpoint: "http://fcm.googleapis.com/x", keys: KEYS }, { endpoint: chrome().endpoint, keys: { p256dh: "x", auth: "y" } }]) {
        const res = await me.agent.post("/api/push/subscribe").send({ subscription: bad });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/subscription/);
      }
      expect(await M.PushSubscription.countDocuments()).toBe(0);
    });

    it("keeps no more than ten devices a person, the oldest going first", { timeout: 60_000 }, async () => {
      const me = await signup(app, "mimi");
      for (let i = 0; i < 11; i++) {
        await on(me, chrome(`dev${i}`));
        await new Promise((r) => setTimeout(r, 5)); // so each is a little newer than the last
      }
      expect((await status(me)).devices).toBe(10);
      expect(await M.PushSubscription.exists({ endpoint: chrome("dev0").endpoint })).toBeNull();
      expect(await M.PushSubscription.exists({ endpoint: chrome("dev10").endpoint })).toBeTruthy();
    });

    it("belongs to whoever signed in on the device last, so two people on one browser never get each other's", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await on(a, chrome("shared"));
      await on(b, chrome("shared"));
      expect((await status(a)).devices).toBe(0);
      expect((await status(b)).devices).toBe(1);
      expect(await M.PushSubscription.countDocuments()).toBe(1);
    });

    it("turns off for one device, only your own, and saying it twice is fine", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await on(a, chrome("mine"));
      expect((await b.agent.post("/api/push/unsubscribe").send({ endpoint: chrome("mine").endpoint })).status).toBe(204); // not theirs
      expect((await status(a)).devices).toBe(1);
      expect((await a.agent.post("/api/push/unsubscribe").send({ endpoint: chrome("mine").endpoint })).status).toBe(204);
      expect((await a.agent.post("/api/push/unsubscribe").send({ endpoint: chrome("mine").endpoint })).status).toBe(204);
      expect((await status(a)).devices).toBe(0);
      expect((await a.agent.post("/api/push/unsubscribe").send({})).status).toBe(400);
    });

    it("limits how often a person can sign devices up", async () => {
      const me = await signup(app, "mimi");
      await M.RateLimitHit.insertMany(Array.from({ length: 20 }, () => ({ key: `push-subscribe:${me.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await on(me)).status).toBe(429);
    });
  });

  describe("choosing which kinds", () => {
    it("has everything on to begin with, and changes only what it is told to", async () => {
      const me = await signup(app, "mimi");
      expect((await status(me)).prefs).toEqual({ messages: true, friends: true, comments: true, events: true, live: true, updates: true });
      const res = await me.agent.patch("/api/push/preferences").send({ messages: false, live: false });
      expect(res.body.prefs).toEqual({ messages: false, friends: true, comments: true, events: true, live: false, updates: true });
      expect((await me.agent.patch("/api/push/preferences").send({ live: true })).body.prefs.messages).toBe(false);
      expect((await status(me)).prefs.live).toBe(true);
    });

    it("refuses what isn't a switch, or isn't true or false, and a switch is the person's own", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      for (const bad of [{}, { nope: true }, { messages: "no" }, { messages: 1 }]) expect((await a.agent.patch("/api/push/preferences").send(bad)).status).toBe(400);
      await a.agent.patch("/api/push/preferences").send({ messages: false });
      expect((await status(b)).prefs.messages).toBe(true);
    });

    it("is never part of what other people can see about someone", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await a.agent.patch("/api/push/preferences").send({ messages: false });
      expect(JSON.stringify((await b.agent.get("/api/profiles/alice")).body)).not.toMatch(/pushPrefs|messages":false/);
      expect(JSON.stringify((await a.agent.get("/api/auth/me")).body)).not.toMatch(/pushPrefs/);
    });
  });

  describe("a test message", () => {
    it("needs a device, goes to your own devices, and is limited", async () => {
      const me = await signup(app, "mimi");
      const other = await signup(app, "other");
      expect((await me.agent.post("/api/push/test")).status).toBe(400);
      await on(me, chrome("one"));
      await on(me, chrome("two"));
      await on(other, chrome("theirs"));
      const res = await me.agent.post("/api/push/test");
      expect(res.body).toEqual({ sent: 2 });
      expect(sent.map((s) => s.endpoint).sort()).toEqual([chrome("one").endpoint, chrome("two").endpoint]);
      expect(sent[0].message).toMatchObject({ title: "CreativesSelect", body: expect.stringMatching(/working/), url: "/" });
      await M.RateLimitHit.insertMany(Array.from({ length: 5 }, () => ({ key: `push-test:${me.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      expect((await me.agent.post("/api/push/test")).status).toBe(429);
    });
  });

  describe("when something happens", () => {
    it("sends the person's devices a note saying who and what, with where to go, and not what was written", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await on(b, chrome("bobs-phone"));
      await on(b, chrome("bobs-laptop"));
      await a.agent.post(`/api/friends/request/${b.user.username}`);
      await settle();
      expect(sent).toHaveLength(2);
      expect(sent.map((s) => s.endpoint).sort()).toEqual([chrome("bobs-laptop").endpoint, chrome("bobs-phone").endpoint]);
      expect(sent[0].message).toMatchObject({ title: "CreativesSelect", body: "alice sent you a friend request", url: "/friends" });
      expect(sent[0].options).toMatchObject({ TTL: 86400 });
      // nothing went to the person who did it
      await on(a, chrome("alices"));
      sent.length = 0;
      await a.agent.post(`/api/friends/request/${b.user.username}`); // again: nothing new
      await settle();
      expect(sent.every((s) => s.endpoint !== chrome("alices").endpoint)).toBe(true);
    });

    it("tells of a message without its words, in one note per sender that counts up", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await befriend(a, b);
      await on(b, chrome("bobs"));
      await a.agent.post("/api/messages/with/bob").send({ body: "my secret plans for tonight" });
      await settle();
      await a.agent.post("/api/messages/with/bob").send({ body: "and a second thing" });
      await settle();
      expect(sent).toHaveLength(2);
      expect(sent[0].message).toMatchObject({ body: "alice sent you a message", url: "/messages/alice" });
      expect(sent[1].message.body).toBe("alice sent you 2 messages");
      expect(sent[1].message.tag).toBe(sent[0].message.tag); // the second replaces the first on the screen
      expect(JSON.stringify(sent)).not.toMatch(/secret|second thing/);
    });

    it("covers the other ways in too: a comment, a blog entry to every friend, a profile comment", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      const c = await signup(app, "cara");
      await befriend(a, b);
      await befriend(a, c);
      await on(a, chrome("alices"));
      await on(b, chrome("bobs"));
      await on(c, chrome("caras"));
      const post = (await a.agent.post("/api/posts").send({ content: "hello" })).body.post;
      sent.length = 0;
      await b.agent.post(`/api/posts/${post.id}/comments`).send({ content: "nice one" });
      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ endpoint: chrome("alices").endpoint, message: { body: "bob commented on your post", url: `/posts/${post.id}` } });
      expect(JSON.stringify(sent)).not.toMatch(/nice one/);

      sent.length = 0;
      await a.agent.post("/api/blog").send({ title: "A private title", body: "Words." });
      await settle();
      expect(sent.map((s) => s.endpoint).sort()).toEqual([chrome("bobs").endpoint, chrome("caras").endpoint]);
      expect(sent[0].message.body).toBe("alice wrote a blog entry");
      expect(JSON.stringify(sent)).not.toMatch(/private title/);

      sent.length = 0;
      await b.agent.post("/api/profiles/alice/comments").send({ content: "hi there" });
      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0].message).toMatchObject({ body: "bob left a comment on your profile", url: "/u/alice#testimonials" });
    });

    it("sends nothing for a kind the person has switched off, and still sends the others", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await befriend(a, b);
      await on(b, chrome("bobs"));
      await b.agent.patch("/api/push/preferences").send({ messages: false });
      await a.agent.post("/api/messages/with/bob").send({ body: "hello" });
      await settle();
      expect(sent).toHaveLength(0);
      expect(await M.Notification.countDocuments({ recipient: b.user.id, type: "message" })).toBe(1); // the bell still has it
      await a.agent.post("/api/blog").send({ title: "T", body: "B" });
      await settle();
      expect(sent).toHaveLength(1);
      await b.agent.patch("/api/push/preferences").send({ messages: true });
      await a.agent.post("/api/messages/with/bob").send({ body: "again" });
      await settle();
      expect(sent).toHaveLength(2);
    });

    it("sends nothing about someone the person muted, and goes on sending about the rest", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      const c = await signup(app, "carol");
      await befriend(a, b);
      await befriend(c, b);
      await on(b, chrome("bobs"));
      sent.length = 0;
      await b.agent.put("/api/mutes/people/alice");
      await a.agent.post("/api/messages/with/bob").send({ body: "hello" });
      await settle();
      expect(sent).toHaveLength(0);
      await c.agent.post("/api/messages/with/bob").send({ body: "hello from carol" });
      await settle();
      expect(sent).toHaveLength(1);
    });

    it("sends nothing to a suspended account, or to someone with no devices, and still makes the notification", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      const c = await signup(app, "cara");
      await on(b, chrome("bobs"));
      await M.User.updateOne({ _id: b.user.id }, { $set: { suspendedAt: new Date() } });
      await a.agent.post(`/api/friends/request/${b.user.username}`);
      await a.agent.post(`/api/friends/request/${c.user.username}`);
      await settle();
      expect(sent).toHaveLength(0);
      expect(await M.Notification.countDocuments({ type: "friend_request" })).toBe(2);
    });

    it("sends at most thirty an hour to one person", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await on(b, chrome("bobs"));
      await M.RateLimitHit.insertMany(Array.from({ length: 30 }, () => ({ key: `push-to-person:${b.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 60_000) })));
      await a.agent.post(`/api/friends/request/${b.user.username}`);
      await settle();
      expect(sent).toHaveLength(0);
      expect(await M.Notification.countDocuments({ recipient: b.user.id })).toBe(1);
    });

    it("forgets a device the browser says is gone, keeps one that just had a hiccup, and never breaks what caused the notification", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      const c = await signup(app, "cara");
      await on(b, chrome("gone"));
      await on(c, chrome("flaky"));
      failWith = (sub) => (sub.endpoint.endsWith("gone") ? { statusCode: 410 } : { statusCode: 503 });
      const first = await a.agent.post(`/api/friends/request/${b.user.username}`);
      const second = await a.agent.post(`/api/friends/request/${c.user.username}`);
      await settle();
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(await M.PushSubscription.exists({ endpoint: chrome("gone").endpoint })).toBeNull();
      expect(await M.PushSubscription.exists({ endpoint: chrome("flaky").endpoint })).toBeTruthy();
      // and a sender that throws without any status at all is survived too
      failWith = () => ({});
      expect((await a.agent.post("/api/blog").send({ title: "T", body: "B" })).status).toBe(201);
      await settle();
    });

    it("does nothing at all, and breaks nothing, when push isn't set up", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await on(b, chrome("bobs"));
      process.env.VAPID_PUBLIC_KEY = "";
      expect((await a.agent.post(`/api/friends/request/${b.user.username}`)).status).toBe(201);
      await settle();
      expect(sent).toHaveLength(0);
      expect(await M.Notification.countDocuments({ recipient: b.user.id })).toBe(1);
    });

    it("is removed with the account, and a deleted person's devices stop getting anything", async () => {
      const a = await signup(app, "alice");
      const b = await signup(app, "bob");
      await on(b, chrome("bobs"));
      await on(a, chrome("alices"));
      expect((await b.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await M.PushSubscription.countDocuments({ user: b.user.id })).toBe(0);
      expect(await M.PushSubscription.countDocuments({ user: a.user.id })).toBe(1);
    });
  });
});
