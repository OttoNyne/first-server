import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.108.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("group boards", () => {
  let app, GroupTopic, GroupReply, Group;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ GroupTopic } = await import("../models/GroupTopic.js"));
    ({ GroupReply } = await import("../models/GroupReply.js"));
    ({ Group } = await import("../models/Group.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  // alice makes the group (so she is its admin); the others join
  async function setup(...names) {
    const alice = await signup(app, "alice");
    const group = (await alice.agent.post("/api/groups").send({ name: "Potters" })).body.group;
    const people = { alice };
    for (const name of names) {
      const key = { bobby: "bob", carah: "cara" }[name] ?? name;
      people[key] = await signup(app, name);
      await people[key].agent.post(`/api/groups/${group.id}/join`);
    }
    return { gid: group.id, ...people };
  }
  const topics = async (who, gid, page) => (await who.agent.get(`/api/groups/${gid}/topics${page ? `?page=${page}` : ""}`)).body;
  const start = (who, gid, over = {}) => who.agent.post(`/api/groups/${gid}/topics`).send({ title: "Kiln recommendations", body: "Which one do you use?\n\nBudget is tight.", ...over });
  const reply = (who, gid, tid, body = "I use a small electric one") => who.agent.post(`/api/groups/${gid}/topics/${tid}/replies`).send({ body });

  it("needs a sign-in", async () => {
    for (const [method, path] of [["get", "/topics"], ["post", "/topics"], ["get", "/topics/5f1d7f3b8f1d7f3b8f1d7f3b"], ["post", "/topics/5f1d7f3b8f1d7f3b8f1d7f3b/replies"]]) {
      expect((await request(app)[method](`/api/groups/5f1d7f3b8f1d7f3b8f1d7f3b${path}`)).status, `${method} ${path}`).toBe(401);
    }
  });

  describe("members only", () => {
    it("refuses people who haven't joined, for reading and writing, and answers 404 for a group that isn't there", async () => {
      const { gid, alice } = await setup();
      const outsider = await signup(app, "outsider");
      await start(alice, gid);
      expect((await outsider.agent.get(`/api/groups/${gid}/topics`)).status).toBe(403);
      expect((await start(outsider, gid)).status).toBe(403);
      expect((await outsider.agent.get(`/api/groups/5f1d7f3b8f1d7f3b8f1d7f3b/topics`)).status).toBe(404);
      expect((await outsider.agent.get(`/api/groups/not-an-id/topics`)).status).toBe(404);
      expect(await GroupTopic.countDocuments()).toBe(1);
    });

    it("ends access when someone leaves, and gives it when they join", async () => {
      const { gid, alice, bob } = await setup("bobby");
      await start(alice, gid);
      expect((await topics(bob, gid)).topics).toHaveLength(1);
      await bob.agent.post(`/api/groups/${gid}/leave`);
      expect((await bob.agent.get(`/api/groups/${gid}/topics`)).status).toBe(403);
      await bob.agent.post(`/api/groups/${gid}/join`);
      expect((await topics(bob, gid)).topics).toHaveLength(1);
    });

    it("keeps each group's board to itself", async () => {
      const { gid, alice } = await setup();
      const other = (await alice.agent.post("/api/groups").send({ name: "Painters" })).body.group;
      const t = (await start(alice, gid)).body.topic;
      expect((await topics(alice, other.id)).topics).toEqual([]);
      expect((await alice.agent.get(`/api/groups/${other.id}/topics/${t.id}`)).status).toBe(404);
      expect((await reply(alice, other.id, t.id)).status).toBe(404);
    });
  });

  describe("topics", () => {
    it("starts a topic with a cleaned title and text, shown with its author", async () => {
      const { gid, alice } = await setup();
      const res = await start(alice, gid, { title: "  Kiln​   talk ", body: "  One.\r\n\r\n\r\n\r\nTwo <b>x</b>.  " });
      expect(res.status).toBe(201);
      expect(res.body.topic).toMatchObject({ title: "Kiln talk", body: "One.\n\nTwo <b>x</b>.", pinned: false, replyCount: 0, mine: true });
      expect(res.body.topic.author.username).toBe("alice");
    });

    it("checks the title and the text", async () => {
      const { gid, alice } = await setup();
      for (const title of ["", "   ", null, 5, "x".repeat(101)]) expect((await start(alice, gid, { title })).status, String(title)).toBe(400);
      for (const body of ["", " \n ", null, 5, ["a"], "x".repeat(2001)]) expect((await start(alice, gid, { body })).status, String(body).slice(0, 6)).toBe(400);
      expect(await GroupTopic.countDocuments()).toBe(0);
      expect((await start(alice, gid, { body: "x".repeat(2000) })).status).toBe(201);
    });

    it("limits how many an hour", async () => {
      const { gid, alice } = await setup();
      for (let i = 0; i < 10; i++) expect((await start(alice, gid, { title: `T${i}` })).status).toBe(201);
      const res = await start(alice, gid);
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
    });

    it("takes the author, group and dates from the session and the address, not the body", async () => {
      const { gid, alice, bob } = await setup("bobby");
      const other = (await alice.agent.post("/api/groups").send({ name: "Painters" })).body.group;
      const res = await start(alice, gid, { author: bob.user.id, group: other.id, pinned: true, replyCount: 99, lastActivityAt: "2001-01-01" });
      const saved = await GroupTopic.findById(res.body.topic.id);
      expect(String(saved.author)).toBe(alice.user.id);
      expect(String(saved.group)).toBe(gid);
      expect(saved.pinned).toBe(false);
      expect(saved.replyCount).toBe(0);
      expect(saved.lastActivityAt.getFullYear()).toBeGreaterThan(2020);
    });

    it("lists pinned topics first, then the most recently active, twenty a page", async () => {
      const { gid, alice } = await setup();
      const now = Date.now();
      await GroupTopic.insertMany(
        Array.from({ length: 22 }, (_, i) => ({ group: gid, author: alice.user.id, title: `Topic ${i}`, body: "x", lastActivityAt: new Date(now - i * 1000) })),
      );
      await GroupTopic.updateOne({ title: "Topic 21" }, { $set: { pinned: true } });
      const first = await topics(alice, gid);
      expect(first.topics).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.topics[0].title).toBe("Topic 21"); // pinned
      expect(first.topics[1].title).toBe("Topic 0"); // newest
      const second = await topics(alice, gid, 2);
      expect(second.topics.map((t) => t.title)).toEqual(["Topic 19", "Topic 20"].slice(0, second.topics.length));
      expect(second.hasMore).toBe(false);
    });

    it("lets a busy topic rise to the top when someone replies", async () => {
      const { gid, alice, bob } = await setup("bobby");
      const older = (await start(alice, gid, { title: "Older" })).body.topic;
      await new Promise((r) => setTimeout(r, 15));
      await start(alice, gid, { title: "Newer" });
      expect((await topics(bob, gid)).topics.map((t) => t.title)).toEqual(["Newer", "Older"]);
      await new Promise((r) => setTimeout(r, 15));
      await reply(bob, gid, older.id);
      const list = (await topics(bob, gid)).topics;
      expect(list.map((t) => t.title)).toEqual(["Older", "Newer"]);
      expect(list[0].replyCount).toBe(1);
    });
  });

  describe("replies", () => {
    it("adds replies, oldest first, with the count kept", async () => {
      const { gid, alice, bob } = await setup("bobby");
      const t = (await start(alice, gid)).body.topic;
      const r1 = await reply(bob, gid, t.id, "  First  ");
      expect(r1.status).toBe(201);
      expect(r1.body.reply).toMatchObject({ body: "First", mine: true });
      await reply(alice, gid, t.id, "Second");
      const view = (await bob.agent.get(`/api/groups/${gid}/topics/${t.id}`)).body;
      expect(view.topic.replyCount).toBe(2);
      expect(view.replies.map((r) => r.body)).toEqual(["First", "Second"]);
      expect(view.replies[0].author.username).toBe("bobby");
      expect(view.hasMore).toBe(false);
    });

    it("checks the text, the topic, and the speed", async () => {
      const { gid, alice } = await setup();
      const t = (await start(alice, gid)).body.topic;
      for (const body of ["", "  ", null, 5, ["x"], "x".repeat(1001)]) expect((await reply(alice, gid, t.id, body)).status, String(body).slice(0, 6)).toBe(400);
      expect((await reply(alice, gid, "5f1d7f3b8f1d7f3b8f1d7f3b")).status).toBe(404);
      expect((await reply(alice, gid, "not-an-id")).status).toBe(404);
      for (let i = 0; i < 30; i++) expect((await reply(alice, gid, t.id, `r${i}`)).status).toBe(201);
      expect((await reply(alice, gid, t.id)).status).toBe(429);
    });

    it("shows fifty at a time", async () => {
      const { gid, alice } = await setup();
      const t = (await start(alice, gid)).body.topic;
      await GroupReply.insertMany(Array.from({ length: 52 }, (_, i) => ({ topic: t.id, group: gid, author: alice.user.id, body: `r${i}` })));
      const one = (await alice.agent.get(`/api/groups/${gid}/topics/${t.id}`)).body;
      expect(one.replies).toHaveLength(50);
      expect(one.hasMore).toBe(true);
      const two = (await alice.agent.get(`/api/groups/${gid}/topics/${t.id}?page=2`)).body;
      expect(two.replies.map((r) => r.body)).toEqual(["r50", "r51"]);
      expect(two.hasMore).toBe(false);
    });
  });

  describe("removing", () => {
    it("lets an author, or a group admin, remove a topic with its replies, and nobody else", async () => {
      const { gid, alice, bob, cara } = await setup("bobby", "carah");
      const mine = (await start(bob, gid, { title: "Bob's" })).body.topic;
      const theirs = (await start(bob, gid, { title: "Bob's too" })).body.topic;
      await reply(alice, gid, mine.id);
      expect((await cara.agent.delete(`/api/groups/${gid}/topics/${mine.id}`)).status).toBe(404);
      expect(await GroupTopic.countDocuments()).toBe(2);
      expect((await bob.agent.delete(`/api/groups/${gid}/topics/${mine.id}`)).status).toBe(204);
      expect(await GroupReply.countDocuments()).toBe(0);
      expect((await alice.agent.delete(`/api/groups/${gid}/topics/${theirs.id}`)).status).toBe(204); // admin
      expect(await GroupTopic.countDocuments()).toBe(0);
      expect((await alice.agent.delete(`/api/groups/${gid}/topics/${theirs.id}`)).status).toBe(404);
      expect((await alice.agent.delete(`/api/groups/${gid}/topics/not-an-id`)).status).toBe(404);
    });

    it("lets an author, or a group admin, remove a reply, and the count follows", async () => {
      const { gid, alice, bob, cara } = await setup("bobby", "carah");
      const t = (await start(alice, gid)).body.topic;
      const r1 = (await reply(bob, gid, t.id, "mine")).body.reply;
      const r2 = (await reply(cara, gid, t.id, "carah's")).body.reply;
      expect((await cara.agent.delete(`/api/groups/${gid}/topics/${t.id}/replies/${r1.id}`)).status).toBe(404);
      expect((await bob.agent.delete(`/api/groups/${gid}/topics/${t.id}/replies/${r1.id}`)).status).toBe(204);
      expect((await alice.agent.delete(`/api/groups/${gid}/topics/${t.id}/replies/${r2.id}`)).status).toBe(204); // admin
      expect((await GroupTopic.findById(t.id)).replyCount).toBe(0);
      expect((await alice.agent.delete(`/api/groups/${gid}/topics/${t.id}/replies/${r2.id}`)).status).toBe(404);
      expect((await alice.agent.delete(`/api/groups/${gid}/topics/${t.id}/replies/not-an-id`)).status).toBe(404);
    });

    it("doesn't let an admin of one group remove things in another", async () => {
      const { gid, alice, bob } = await setup("bobby");
      const t = (await start(bob, gid)).body.topic;
      const dan = await signup(app, "daniel");
      const own = (await dan.agent.post("/api/groups").send({ name: "Dans" })).body.group; // dan is admin there
      expect((await dan.agent.delete(`/api/groups/${own.id}/topics/${t.id}`)).status).toBe(404);
      expect((await dan.agent.delete(`/api/groups/${gid}/topics/${t.id}`)).status).toBe(403); // not a member of this group
      expect(alice).toBeTruthy();
    });
  });

  describe("pinning", () => {
    it("lets only an admin pin and unpin, up to three", async () => {
      const { gid, alice, bob } = await setup("bobby");
      const made = [];
      for (let i = 0; i < 4; i++) made.push((await start(bob, gid, { title: `T${i}` })).body.topic);
      const pin = (who, t, pinned = true) => who.agent.put(`/api/groups/${gid}/topics/${t.id}/pin`).send({ pinned });
      expect((await pin(bob, made[0])).status).toBe(403);
      for (let i = 0; i < 3; i++) expect((await pin(alice, made[i])).body.topic.pinned).toBe(true);
      expect((await pin(alice, made[3])).status).toBe(400);
      expect((await pin(alice, made[0])).status).toBe(200); // already pinned: fine
      expect((await pin(alice, made[0], false)).body.topic.pinned).toBe(false);
      expect((await pin(alice, made[3])).status).toBe(200);
      expect((await topics(bob, gid)).topics.filter((t) => t.pinned)).toHaveLength(3);
    });

    it("checks the value and the topic", async () => {
      const { gid, alice } = await setup();
      const t = (await start(alice, gid)).body.topic;
      for (const pinned of ["yes", 1, null, undefined]) expect((await alice.agent.put(`/api/groups/${gid}/topics/${t.id}/pin`).send({ pinned })).status, String(pinned)).toBe(400);
      expect((await alice.agent.put(`/api/groups/${gid}/topics/5f1d7f3b8f1d7f3b8f1d7f3b/pin`).send({ pinned: true })).status).toBe(404);
      expect((await alice.agent.put(`/api/groups/${gid}/topics/not-an-id/pin`).send({ pinned: true })).status).toBe(404);
    });
  });

  describe("blocking", () => {
    it("leaves out topics and replies from people you've blocked or who blocked you", async () => {
      const { gid, alice, bob, cara } = await setup("bobby", "carah");
      const bobs = (await start(bob, gid, { title: "Bob's topic" })).body.topic;
      const caras = (await start(cara, gid, { title: "Cara's topic" })).body.topic;
      await reply(bob, gid, caras.id, "bob replies");
      await reply(cara, gid, caras.id, "cara replies");
      await alice.agent.post("/api/users/bobby/block");
      expect((await topics(alice, gid)).topics.map((t) => t.title)).toEqual(["Cara's topic"]);
      expect((await alice.agent.get(`/api/groups/${gid}/topics/${bobs.id}`)).status).toBe(404);
      expect((await reply(alice, gid, bobs.id)).status).toBe(404);
      expect((await alice.agent.get(`/api/groups/${gid}/topics/${caras.id}`)).body.replies.map((r) => r.body)).toEqual(["cara replies"]);
      // and from the blocked person's side, the same: alice's things are hidden from bob
      const alices = (await start(alice, gid, { title: "Alice's topic" })).body.topic;
      expect((await topics(bob, gid)).topics.map((t) => t.title)).toEqual(["Cara's topic", "Bob's topic"]); // his own and hers, not alice's
      expect((await bob.agent.get(`/api/groups/${gid}/topics/${alices.id}`)).status).toBe(404);
      expect((await reply(bob, gid, alices.id)).status).toBe(404);
    });
  });

  describe("reports", () => {
    it("lets a member report a topic or a reply, and the reports go with the author's account", async () => {
      const { gid, alice, bob } = await setup("bobby");
      const { Report } = await import("../models/Report.js");
      const t = (await start(bob, gid)).body.topic;
      const r = (await reply(bob, gid, t.id)).body.reply;
      expect((await alice.agent.post("/api/reports").send({ targetType: "groupTopic", targetId: t.id, reason: "spam" })).status).toBe(201);
      expect((await alice.agent.post("/api/reports").send({ targetType: "groupReply", targetId: r.id, reason: "rude" })).status).toBe(201);
      expect(await Report.countDocuments({ targetType: { $in: ["groupTopic", "groupReply"] } })).toBe(2);
      expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Report.countDocuments({ targetType: { $in: ["groupTopic", "groupReply"] } })).toBe(0);
    });
  });

  describe("accounts and groups going away", () => {
    it("removes a person's topics (with every reply in them) and their replies elsewhere, keeping the counts right", async () => {
      const { gid, alice, bob } = await setup("bobby");
      const bobs = (await start(bob, gid, { title: "Bob's" })).body.topic;
      const alices = (await start(alice, gid, { title: "Alice's" })).body.topic;
      await reply(alice, gid, bobs.id, "alice in bob's");
      await reply(bob, gid, alices.id, "bob in alice's");
      await reply(alice, gid, alices.id, "alice in hers");
      expect((await bob.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect((await GroupTopic.find()).map((t) => t.title)).toEqual(["Alice's"]);
      expect((await GroupReply.find()).map((r) => r.body)).toEqual(["alice in hers"]);
      expect((await GroupTopic.findOne({ title: "Alice's" })).replyCount).toBe(1);
    });

    it("removes the whole board when an empty group goes with its last member", async () => {
      const { gid, alice } = await setup();
      const t = (await start(alice, gid)).body.topic;
      await reply(alice, gid, t.id);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await Group.countDocuments()).toBe(0);
      expect(await GroupTopic.countDocuments()).toBe(0);
      expect(await GroupReply.countDocuments()).toBe(0);
    });
  });
});
