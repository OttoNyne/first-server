import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { MAX_MENTIONS, isSitePath, mentionsIn } from "../utils/mentions.js";
import { pushBody } from "../utils/pushText.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.112.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("finding @mentions in text", () => {
  it("finds names that start a word, lower-cased, each once, in order", () => {
    expect(mentionsIn("hi @Alice and @bob_2, also @alice again")).toEqual(["alice", "bob_2"]);
    expect(mentionsIn("@sam\n@lee_x")).toEqual(["sam", "lee_x"]);
    expect(mentionsIn("(@maria) said \"@jose\"")).toEqual(["maria", "jose"]);
  });
  it("ignores email addresses, names glued to a word, runs of @, names that are too short, and non-text", () => {
    for (const text of ["mail me at sam@example.com", "hi@bob", "@@bob", "@ab", "@", "no mention here", "", "a @b", null, undefined, 5, {}]) expect(mentionsIn(text), String(text)).toEqual([]);
  });
  it("stops at 30 characters of name and at five people", () => {
    expect(mentionsIn(`@${"a".repeat(31)}`)).toEqual([]);
    expect(mentionsIn(`@${"a".repeat(30)}`)).toEqual(["a".repeat(30)]);
    const many = mentionsIn("@aaa @bbb @ccc @ddd @eee @fff @ggg");
    expect(many).toHaveLength(MAX_MENTIONS);
    expect(many.at(-1)).toBe("eee");
  });
  it("takes a name followed by punctuation, but not by more of a word", () => {
    expect(mentionsIn("thanks @sam!")).toEqual(["sam"]);
    expect(mentionsIn("@sam's piece")).toEqual(["sam"]);
    expect(mentionsIn("@sam-lee")).toEqual(["sam"]);
  });
  it("only accepts addresses inside the site for a notification to go to", () => {
    for (const ok of ["/posts/1", "/u/sam?piece=2#portfolio", "/"]) expect(isSitePath(ok), ok).toBe(true);
    for (const bad of ["//evil.example", "https://evil.example", "javascript:alert(1)", "posts/1", "/\\evil", "", null, 5, `/${"a".repeat(400)}`]) expect(isSitePath(bad), String(bad)).toBe(false);
  });
  it("has the words for a phone notification in every language", () => {
    expect(pushBody("mention", "en", { who: "Sam" })).toBe("Sam mentioned you");
    expect(pushBody("mention", "es", { who: "Sam" })).toContain("Sam");
    expect(pushBody("mention", "ar", { who: "Sam" })).toContain("Sam");
  });
});

describe("telling people they were mentioned", () => {
  let app, Notification, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Notification } = await import("../models/Notification.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const told = async (who) => Notification.find({ recipient: who.user.id, type: "mention" }).lean();
  const post = (who, content) => who.agent.post("/api/posts").send({ content });

  describe("in posts", () => {
    it("tells a friend who is named, with where to go and who named them, and nobody else", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await befriend(alice, bob);
      await befriend(alice, cara);
      const made = await post(alice, "Lovely day with @bobby");
      expect(made.status).toBe(201);
      const got = await told(bob);
      expect(got).toHaveLength(1);
      expect(got[0].payload).toMatchObject({ actorId: alice.user.id, url: `/posts/${made.body.post.id}` });
      expect(await told(cara)).toHaveLength(0);
      expect(await told(alice)).toHaveLength(0);
    });
    it("does not tell you about naming yourself, or someone who doesn't exist, or a name that is part of an email", async () => {
      const alice = await signup(app, "alice");
      await post(alice, "me @alice, @nobodyhere, and write to bobby@example.com");
      expect(await Notification.countDocuments({ type: "mention" })).toBe(0);
    });
    it("tells a stranger when the author's profile is public, but not when it is private and they aren't a friend", async () => {
      const alice = await signup(app, "alice");
      const stranger = await signup(app, "strange");
      await post(alice, "hello @strange");
      expect(await told(stranger)).toHaveLength(1);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await post(alice, "again @strange");
      expect(await told(stranger)).toHaveLength(1);
    });
    it("does not reach someone who blocked the writer, or someone the writer blocked", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await bob.agent.post("/api/users/alice/block");
      await alice.agent.post("/api/users/carla/block");
      await post(alice, "@bobby @carla hello");
      expect(await told(bob)).toHaveLength(0);
      expect(await told(cara)).toHaveLength(0);
    });
    it("does not reach a suspended person", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await User.updateOne({ username: "bobby" }, { suspendedAt: new Date() });
      await post(alice, "@bobby");
      expect(await told(bob)).toHaveLength(0);
    });
    it("names at most five people in one go", async () => {
      const alice = await signup(app, "alice");
      const people = [];
      for (const n of ["ppla", "pplb", "pplc", "ppld", "pple", "pplf"]) people.push(await signup(app, n));
      await post(alice, "@ppla @pplb @pplc @ppld @pple @pplf");
      expect(await Notification.countDocuments({ type: "mention" })).toBe(5);
    });
    it("when a post is edited, tells only the people newly named", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const made = await post(alice, "with @bobby");
      expect(await told(bob)).toHaveLength(1);
      expect((await alice.agent.patch(`/api/posts/${made.body.post.id}`).send({ content: "with @bobby and @carla" })).status).toBe(200);
      expect(await told(bob)).toHaveLength(1);
      expect(await told(cara)).toHaveLength(1);
    });
    it("a mention is not a reason to refuse a post when it can't be delivered", async () => {
      const alice = await signup(app, "alice");
      expect((await post(alice, "nobody @ghostly here")).status).toBe(201);
    });
    it("a notification for a mention appears in the person's list with who wrote it", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await post(alice, "hi @bobby");
      const list = await bob.agent.get("/api/notifications");
      expect(list.status).toBe(200);
      const n = list.body.notifications.find((x) => x.type === "mention");
      expect(n.actor.username).toBe("alice");
      expect(n.payload.url).toMatch(/^\/posts\//);
    });
  });

  describe("in comments", () => {
    it("tells the person named in a comment on a post, and the post's author gets only the usual comment notice", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const made = await post(alice, "a post");
      const res = await bob.agent.post(`/api/posts/${made.body.post.id}/comments`).send({ content: "ask @carla and @alice" });
      expect(res.status).toBe(201);
      const got = await told(cara);
      expect(got).toHaveLength(1);
      expect(got[0].payload.url).toBe(`/posts/${made.body.post.id}?comment=${res.body.comment.id}`);
      expect(await told(alice)).toHaveLength(0); // already told about the comment itself
      expect(await Notification.countDocuments({ recipient: alice.user.id, type: "comment" })).toBe(1);
    });
    it("tells people named in an edit of a comment, once", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const made = await post(alice, "a post");
      const c = await bob.agent.post(`/api/posts/${made.body.post.id}/comments`).send({ content: "first" });
      await bob.agent.patch(`/api/comments/${c.body.comment.id}`).send({ content: "first, thanks @carla" });
      await bob.agent.patch(`/api/comments/${c.body.comment.id}`).send({ content: "first, thanks @carla!" });
      expect(await told(cara)).toHaveLength(1);
    });
    it("in testimonials on a profile", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const res = await bob.agent.post("/api/profiles/alice/comments").send({ content: "Great, like @carla says" });
      expect(res.status).toBe(201);
      expect((await told(cara))[0].payload.url).toBe("/u/alice#testimonials");
    });
    it("on a portfolio piece, going to the piece and the comment", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const piece = (await alice.agent.post("/api/media").send({ type: "image", url: "https://img.example.com/a.png" })).body.mediaItem;
      const res = await bob.agent.post(`/api/media/${piece.id}/comments`).send({ content: "see @carla" });
      expect(res.status).toBe(201);
      expect((await told(cara))[0].payload.url).toBe(`/u/alice?piece=${piece.id}&comment=${res.body.comment.id}#portfolio`);
    });
    it("on a blog entry", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const entry = (await alice.agent.post("/api/blog").send({ title: "Notes", body: "Some notes" })).body.entry;
      const res = await bob.agent.post(`/api/blog/${entry.id}/comments`).send({ content: "cc @carla" });
      expect(res.status).toBe(201);
      expect((await told(cara))[0].payload.url).toBe(`/blog/${entry.id}?comment=${res.body.comment.id}`);
    });
    it("is not sent about a private profile's post to someone who couldn't open it", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await befriend(alice, bob);
      const made = await post(alice, "private chat");
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await bob.agent.post(`/api/posts/${made.body.post.id}/comments`).send({ content: "psst @carla" });
      expect(await told(cara)).toHaveLength(0);
    });
  });

  describe("in blog entries, bulletins, events and help requests", () => {
    it("a blog entry names people in its text", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const made = await alice.agent.post("/api/blog").send({ title: "Thanks", body: "To @bobby for the help" });
      expect(made.status).toBe(201);
      expect((await told(bob))[0].payload.url).toBe(`/blog/${made.body.entry.id}`);
      await alice.agent.put(`/api/blog/${made.body.entry.id}`).send({ body: "To @bobby for the help, again" });
      expect(await told(bob)).toHaveLength(1);
    });
    it("a bulletin reaches only friends", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await befriend(alice, bob);
      const res = await alice.agent.post("/api/bulletins").send({ title: "Show", body: "With @bobby and @carla" });
      expect(res.status).toBe(201);
      expect(await told(bob)).toHaveLength(1);
      expect(await told(cara)).toHaveLength(0);
    });
    it("an event names people in its description, when they can see it", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await befriend(alice, bob);
      const res = await alice.agent.post("/api/events").send({ title: "Life drawing", kind: "in_person", place: "The mill", description: "Hosted with @bobby", startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
      expect(res.status).toBe(201);
      expect((await told(bob))[0].payload.url).toBe(`/events/${res.body.event.id}`);
    });
    it("a public help request names people, a private to-do doesn't", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await alice.agent.post("/api/tasks").send({ title: "Private list", description: "ask @bobby", isPublic: false });
      expect(await told(bob)).toHaveLength(0);
      await alice.agent.post("/api/tasks").send({ title: "Need a logo", description: "maybe @bobby can", isPublic: true });
      expect((await told(bob))[0].payload.url).toBe("/help-wanted");
    });
  });

  describe("in groups", () => {
    it("tells members who are named in the group chat or board, and not people outside the group", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      const group = (await alice.agent.post("/api/groups").send({ name: "Potters" })).body.group;
      await bob.agent.post(`/api/groups/${group.id}/join`);
      expect((await alice.agent.post(`/api/groups/${group.id}/messages`).send({ body: "welcome @bobby and @carla" })).status).toBe(201);
      expect(await told(bob)).toHaveLength(1);
      expect(await told(cara)).toHaveLength(0);
      const topic = await alice.agent.post(`/api/groups/${group.id}/topics`).send({ title: "Kilns", body: "What about @bobby?" });
      expect(topic.status).toBe(201);
      expect(await told(bob)).toHaveLength(2);
      expect((await bob.agent.post(`/api/groups/${group.id}/topics/${topic.body.topic.id}/replies`).send({ body: "yes @alice" })).status).toBe(201);
      expect((await told(alice))[0].payload.url).toBe(`/groups/${group.id}`);
    });
  });

  describe("the list offered while typing", () => {
    it("needs a sign-in", async () => {
      expect((await request(app).get("/api/mentions/suggest?q=a")).status).toBe(401);
    });
    it("puts friends first, matches the start of a username or of a word in a name, and leaves out yourself", async () => {
      const me = await signup(app, "samuel");
      const friend = await signup(app, "sandra");
      await signup(app, "sabrina");
      await signup(app, "other");
      await befriend(me, friend);
      const res = await me.agent.get("/api/mentions/suggest?q=sa");
      expect(res.status).toBe(200);
      expect(res.body.people.map((p) => p.username)).toEqual(["sandra", "sabrina"]);
      expect(res.body.people.map((p) => p.isFriend)).toEqual([true, false]);
      expect((await me.agent.get("/api/mentions/suggest?q=@san")).body.people.map((p) => p.username)).toEqual(["sandra"]);
      expect(res.body.people.every((p) => !("email" in p))).toBe(true);
    });
    it("offers just friends before anything is typed", async () => {
      const me = await signup(app, "samuel");
      const friend = await signup(app, "sandra");
      await signup(app, "sabrina");
      await befriend(me, friend);
      expect((await me.agent.get("/api/mentions/suggest")).body.people.map((p) => p.username)).toEqual(["sandra"]);
    });
    it("leaves out blocked, suspended and private strangers, but keeps a private friend", async () => {
      const me = await signup(app, "samuel");
      const blocked = await signup(app, "sblocked");
      const blocker = await signup(app, "sblocker");
      const gone = await signup(app, "sgone");
      const hidden = await signup(app, "shidden");
      const closeFriend = await signup(app, "sclose");
      await me.agent.post("/api/users/sblocked/block");
      await blocker.agent.post("/api/users/samuel/block");
      await User.updateOne({ username: "sgone" }, { suspendedAt: new Date() });
      await hidden.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await closeFriend.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await befriend(me, closeFriend);
      const names = (await me.agent.get("/api/mentions/suggest?q=s")).body.people.map((p) => p.username);
      expect(names).toEqual(["sclose"]);
      void blocked; void gone;
    });
    it("gives nothing for something that can't be a name, and never more than eight", async () => {
      const me = await signup(app, "samuel");
      expect((await me.agent.get("/api/mentions/suggest?q=" + encodeURIComponent("a b"))).body.people).toEqual([]);
      expect((await me.agent.get("/api/mentions/suggest?q=" + encodeURIComponent(".*"))).body.people).toEqual([]);
      for (let i = 0; i < 10; i++) await signup(app, `tester${i}`);
      expect((await me.agent.get("/api/mentions/suggest?q=tester")).body.people).toHaveLength(8);
    });
  });
});
