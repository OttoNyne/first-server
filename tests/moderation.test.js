import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name, { admin = false } = {}) {
  const agent = request.agent(app);
  signups += 1;
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${130 + Math.floor(signups / 250)}.${(signups % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user, email: `${name}@example.com`, admin };
}

describe("moderation review queue", () => {
  let app, M;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com, Second@Example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Post: (await import("../models/Post.js")).Post,
      Comment: (await import("../models/Comment.js")).Comment,
      ProfileComment: (await import("../models/ProfileComment.js")).ProfileComment,
      BlogEntry: (await import("../models/BlogEntry.js")).BlogEntry,
      Bulletin: (await import("../models/Bulletin.js")).Bulletin,
      GroupTopic: (await import("../models/GroupTopic.js")).GroupTopic,
      GroupReply: (await import("../models/GroupReply.js")).GroupReply,
      Report: (await import("../models/Report.js")).Report,
      Notification: (await import("../models/Notification.js")).Notification,
      ModerationAction: (await import("../models/ModerationAction.js")).ModerationAction,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
    await disconnectTestDb();
  });

  // an administrator: listed in ADMIN_EMAILS, and with the address confirmed
  async function makeAdmin(name = "boss") {
    const a = await signup(app, name);
    await M.User.updateOne({ _id: a.user.id }, { $set: { emailVerified: true } });
    return a;
  }
  const report = (who, targetType, targetId, reason = "not ok") => who.agent.post("/api/reports").send({ targetType, targetId: String(targetId), reason });
  const queue = async (admin, page) => (await admin.agent.get(`/api/admin/reports${page ? `?page=${page}` : ""}`)).body;
  const resolve = (admin, targetType, targetId, action, note) => admin.agent.post("/api/admin/reports/resolve").send({ targetType, targetId: String(targetId), action, ...(note !== undefined ? { note } : {}) });
  const notesOf = async (who, type) => (await who.agent.get("/api/notifications")).body.notifications.filter((n) => n.type === type);
  const login = (email, password = "password123") => request(app).post("/api/auth/login").send({ email, password });

  describe("who is an administrator", () => {
    it("is nobody unless ADMIN_EMAILS lists them AND their address is confirmed", async () => {
      const boss = await signup(app, "boss"); // listed, not confirmed
      expect((await boss.agent.get("/api/admin/reports")).status).toBe(404);
      await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
      expect((await boss.agent.get("/api/admin/reports")).status).toBe(200);
      const other = await signup(app, "other"); // confirmed, not listed
      await M.User.updateOne({ _id: other.user.id }, { $set: { emailVerified: true } });
      expect((await other.agent.get("/api/admin/reports")).status).toBe(404);
    });

    it("matches addresses in any case and ignores spaces in the list", async () => {
      const second = await makeAdmin("second");
      expect((await second.agent.get("/api/admin/reports")).status).toBe(200);
    });

    it("answers 401 to signed-out visitors and 404 to everyone else, for every admin route", async () => {
      const alice = await signup(app, "alice");
      for (const [method, path] of [["get", "/api/admin/reports"], ["post", "/api/admin/reports/resolve"], ["get", "/api/admin/actions"], ["get", "/api/admin/suspended"], ["post", "/api/admin/users/5f1d7f3b8f1d7f3b8f1d7f3b/unsuspend"]]) {
        expect((await request(app)[method](path)).status, `anon ${path}`).toBe(401);
        expect((await alice.agent[method](path)).status, `user ${path}`).toBe(404);
      }
    });

    it("is checked on every request: removing someone from the list ends their access at once", async () => {
      const boss = await makeAdmin();
      expect((await boss.agent.get("/api/admin/reports")).status).toBe(200);
      const before = process.env.ADMIN_EMAILS;
      process.env.ADMIN_EMAILS = "somebody-else@example.com";
      expect((await boss.agent.get("/api/admin/reports")).status).toBe(404);
      process.env.ADMIN_EMAILS = before;
    });

    it("is told to the person themself, and to nobody else, on their profile", async () => {
      const boss = await makeAdmin();
      const alice = await signup(app, "alice");
      expect((await boss.agent.get("/api/profiles/boss")).body.user.isAdmin).toBe(true);
      expect((await alice.agent.get("/api/profiles/alice")).body.user.isAdmin).toBe(false);
      expect("isAdmin" in (await alice.agent.get("/api/profiles/boss")).body.user).toBe(false);
    });
  });

  describe("making a report", () => {
    it("checks the target, the reason, and that you aren't reporting yourself", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      expect((await report(alice, "user", "not-an-id")).status).toBe(400);
      expect((await report(alice, "user", "5f1d7f3b8f1d7f3b8f1d7f3b")).status).toBe(404);
      expect((await report(alice, "user", alice.user.id)).status).toBe(400);
      expect((await alice.agent.post("/api/reports").send({ targetType: "user", targetId: bob.user.id, reason: "   " })).status).toBe(400);
      expect((await alice.agent.post("/api/reports").send({ targetType: "user", targetId: bob.user.id, reason: "x".repeat(501) })).status).toBe(400);
      expect((await alice.agent.post("/api/reports").send({ targetType: "user", targetId: bob.user.id, reason: 5 })).status).toBe(400);
      expect(await M.Report.countDocuments()).toBe(0);
    });

    it("cleans the reason, and reporting the same thing twice while it waits is one report", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const first = await report(alice, "user", bob.user.id, "  rude​   words ");
      expect(first.status).toBe(201);
      expect(first.body.report.reason).toBe("rude words");
      const again = await report(alice, "user", bob.user.id, "still rude");
      expect(again.status).toBe(200);
      expect(again.body.duplicate).toBe(true);
      expect(await M.Report.countDocuments()).toBe(1);
    });

    it("limits how many an hour", async () => {
      const alice = await signup(app, "alice");
      const targets = [];
      for (let i = 0; i < 31; i++) targets.push(await M.Post.create({ author: alice.user.id, content: `p${i}` }));
      const bob = await signup(app, "bobby");
      for (let i = 0; i < 30; i++) expect((await report(bob, "post", targets[i]._id)).status).toBe(201);
      const res = await report(bob, "post", targets[30]._id);
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
    });
  });

  describe("the queue", () => {
    it("groups reports by what was reported, most recent first, with a preview of each kind of thing", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const reporters = [await signup(app, "rep1"), await signup(app, "rep2"), await signup(app, "rep3")];
      const post = await M.Post.create({ author: author.user.id, content: "A rude post" });
      const comment = await M.Comment.create({ post: post._id, author: author.user.id, content: "A rude comment" });
      const testimonial = await M.ProfileComment.create({ profileOwner: reporters[0].user.id, author: author.user.id, content: "A rude testimonial" });
      const entry = await M.BlogEntry.create({ author: author.user.id, title: "Blog title", body: "Blog body" });
      const bulletin = await M.Bulletin.create({ author: author.user.id, title: "Bulletin title", body: "Bulletin body", expireAt: new Date(Date.now() + 1e9) });
      const topic = await M.GroupTopic.create({ group: "5f1d7f3b8f1d7f3b8f1d7f3b", author: author.user.id, title: "Topic title", body: "Topic body", lastActivityAt: new Date() });
      const reply = await M.GroupReply.create({ topic: topic._id, group: "5f1d7f3b8f1d7f3b8f1d7f3b", author: author.user.id, body: "A rude reply" });
      const things = [["post", post], ["comment", comment], ["profileComment", testimonial], ["blogEntry", entry], ["bulletin", bulletin], ["groupTopic", topic], ["groupReply", reply]];
      for (const [type, doc] of things) {
        await report(reporters[0], type, doc._id, `${type} reason`);
        await new Promise((r) => setTimeout(r, 5));
      }
      await report(reporters[0], "user", author.user.id, "bad account");
      await report(reporters[1], "post", post._id, "same post, second report");
      await report(reporters[2], "post", post._id, "same post, third report");

      const { cases, hasMore } = await queue(boss);
      expect(hasMore).toBe(false);
      expect(cases).toHaveLength(8); // seven things and one account
      const byType = Object.fromEntries(cases.map((c) => [c.targetType, c]));
      expect(byType.post.count).toBe(3);
      expect(byType.post.reports.map((r) => r.reason).sort()).toEqual(["post reason", "same post, second report", "same post, third report"]);
      expect(byType.post.reports[0].reporter.username).toBeTruthy();
      for (const type of ["post", "comment", "profileComment", "blogEntry", "bulletin", "groupTopic", "groupReply", "user"]) {
        expect(byType[type].exists, type).toBe(true);
        expect(byType[type].target.author.username, type).toBe("author");
      }
      expect(byType.post.target.text).toBe("A rude post");
      expect(byType.post.target.link).toBe(`/posts/${post._id}`);
      expect(byType.blogEntry.target).toMatchObject({ title: "Blog title", text: "Blog body" });
      expect(byType.bulletin.target).toMatchObject({ title: "Bulletin title", link: null });
      expect(byType.groupReply.target.link).toBe("/groups/5f1d7f3b8f1d7f3b8f1d7f3b");
      expect(byType.user.target.link).toBe("/u/author");
      expect(cases[0].targetType).toBe("post"); // reported last
    });

    it("shows what has already been deleted as gone, and long text cut short, and writing as text", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const long = await M.Post.create({ author: author.user.id, content: `<b>bold</b> ${"x".repeat(900)}` });
      const gone = await M.Post.create({ author: author.user.id, content: "will be deleted" });
      await report(rep, "post", long._id);
      await report(rep, "post", gone._id);
      await M.Post.deleteOne({ _id: gone._id });
      const { cases } = await queue(boss);
      const goneCase = cases.find((c) => String(c.targetId) === String(gone._id));
      expect(goneCase).toMatchObject({ exists: false, target: null });
      const longCase = cases.find((c) => String(c.targetId) === String(long._id));
      expect(longCase.target.text.startsWith("<b>bold</b> ")).toBe(true);
      expect(longCase.target.text.length).toBeLessThanOrEqual(601);
      expect(longCase.target.text.endsWith("…")).toBe(true);
    });

    it("tells the moderator when something was changed after it was written", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const made = (await author.agent.post("/api/posts").send({ content: "Original words" })).body.post;
      await report(rep, "post", made.id);
      expect((await queue(boss)).cases[0].target.edited).toBe(false);
      await author.agent.patch(`/api/posts/${made.id}`).send({ content: "Different words" });
      const { cases } = await queue(boss);
      expect(cases[0].target).toMatchObject({ text: "Different words", edited: true });
    });

    it("pages twenty cases at a time, and leaves out handled ones", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const posts = await M.Post.insertMany(Array.from({ length: 22 }, (_, i) => ({ author: author.user.id, content: `p${i}` })));
      await M.Report.insertMany(posts.map((p, i) => ({ reporter: rep.user.id, targetType: "post", targetId: p._id, reason: "r", createdAt: new Date(Date.now() - i * 1000) })));
      const first = await queue(boss);
      expect(first.cases).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      const second = await queue(boss, 2);
      expect(second.cases).toHaveLength(2);
      expect(second.hasMore).toBe(false);
      await M.Report.updateMany({ targetId: posts[0]._id }, { $set: { status: "dismissed" } });
      expect((await queue(boss, 2)).cases).toHaveLength(1);
    });
  });

  describe("deciding", () => {
    it("dismisses: the reports close, the content stays, reporters are thanked, and it is logged", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const post = await M.Post.create({ author: author.user.id, content: "fine" });
      await report(rep, "post", post._id);
      const res = await resolve(boss, "post", post._id, "dismiss", "  nothing wrong  ");
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("dismissed");
      expect(await M.Post.countDocuments()).toBe(1);
      const saved = await M.Report.findOne();
      expect(saved).toMatchObject({ status: "dismissed", action: "dismissed", note: "nothing wrong" });
      expect(String(saved.reviewedBy)).toBe(boss.user.id);
      expect((await notesOf(rep, "report_resolved"))[0].payload.outcome).toBe("no_action");
      expect(await notesOf(author, "content_removed")).toEqual([]);
      expect((await queue(boss)).cases).toEqual([]);
      expect((await boss.agent.get("/api/admin/actions")).body.actions[0]).toMatchObject({ targetType: "post", action: "dismissed", note: "nothing wrong", reportCount: 1 });
    });

    it("removes each kind of content the way its owner deleting it would, and tells the author and the reporters", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const post = await M.Post.create({ author: author.user.id, content: "bad" });
      const comment = await M.Comment.create({ post: post._id, author: author.user.id, content: "bad" });
      const testimonial = await M.ProfileComment.create({ profileOwner: rep.user.id, author: author.user.id, content: "bad" });
      const entry = await M.BlogEntry.create({ author: author.user.id, title: "t", body: "b" });
      await M.Notification.create({ recipient: rep.user.id, type: "blog_post", payload: { entryId: String(entry._id), actorId: author.user.id, title: "t" } });
      const bulletin = await M.Bulletin.create({ author: author.user.id, title: "t", body: "b", expireAt: new Date(Date.now() + 1e9) });
      const topic = await M.GroupTopic.create({ group: "5f1d7f3b8f1d7f3b8f1d7f3b", author: author.user.id, title: "t", body: "b", replyCount: 1, lastActivityAt: new Date() });
      const reply = await M.GroupReply.create({ topic: topic._id, group: topic.group, author: author.user.id, body: "b" });
      const other = await M.GroupReply.create({ topic: topic._id, group: topic.group, author: rep.user.id, body: "innocent" });
      await M.GroupTopic.updateOne({ _id: topic._id }, { $set: { replyCount: 2 } });
      // the comment before its post, and the reply before its topic: removing a post or topic takes what is inside it
      const things = [["comment", comment, M.Comment], ["profileComment", testimonial, M.ProfileComment], ["blogEntry", entry, M.BlogEntry], ["bulletin", bulletin, M.Bulletin], ["groupReply", reply, M.GroupReply], ["groupTopic", topic, M.GroupTopic], ["post", post, M.Post]];
      for (const [type, doc, Model] of things) {
        await report(rep, type, doc._id);
        const res = await resolve(boss, type, doc._id, "remove");
        expect(res.status, type).toBe(200);
        expect(res.body.removed, type).toBe(true);
        expect(await Model.findById(doc._id), type).toBeNull();
      }
      expect(await M.Comment.countDocuments()).toBe(0);
      expect(await M.GroupReply.countDocuments()).toBe(0); // the topic took the innocent reply with it, as deleting a topic does
      expect(await M.Notification.countDocuments({ type: "blog_post" })).toBe(0);
      expect(other).toBeTruthy();
      const told = await notesOf(author, "content_removed");
      expect(told.map((n) => n.payload.what).sort()).toEqual(["blog entry", "bulletin", "comment", "group reply", "group topic", "post", "testimonial"]);
      expect((await notesOf(rep, "report_resolved")).every((n) => n.payload.outcome === "action_taken")).toBe(true);
      expect((await notesOf(rep, "report_resolved")).length).toBe(7);
      expect((await M.User.findById(author.user.id)).suspendedAt).toBeNull();
    });

    it("keeps a topic's reply count right when only a reply is removed", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const topic = await M.GroupTopic.create({ group: "5f1d7f3b8f1d7f3b8f1d7f3b", author: rep.user.id, title: "t", body: "b", replyCount: 2, lastActivityAt: new Date() });
      const bad = await M.GroupReply.create({ topic: topic._id, group: topic.group, author: author.user.id, body: "bad" });
      await M.GroupReply.create({ topic: topic._id, group: topic.group, author: rep.user.id, body: "fine" });
      await report(rep, "groupReply", bad._id);
      await resolve(boss, "groupReply", bad._id, "remove");
      expect((await M.GroupTopic.findById(topic._id)).replyCount).toBe(1);
    });

    it("suspends the author without removing the content, or does both", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const post = await M.Post.create({ author: author.user.id, content: "bad" });
      await report(rep, "post", post._id);
      const res = await resolve(boss, "post", post._id, "suspend", "repeat offender");
      expect(res.body.outcome).toBe("suspended");
      expect(await M.Post.countDocuments()).toBe(1);
      const u = await M.User.findById(author.user.id);
      expect(u.suspendedAt).toBeInstanceOf(Date);
      expect(u.suspensionNote).toBe("repeat offender");

      const bob = await signup(app, "bobby");
      const post2 = await M.Post.create({ author: bob.user.id, content: "bad too" });
      await report(rep, "post", post2._id);
      const both = await resolve(boss, "post", post2._id, "remove_and_suspend");
      expect(both.body).toMatchObject({ outcome: "removed_and_suspended", removed: true });
      expect(await M.Post.countDocuments({ _id: post2._id })).toBe(0);
      expect((await M.User.findById(bob.user.id)).suspendedAt).toBeInstanceOf(Date);
    });

    it("suspends the account itself for a user report, but never 'removes' an account", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      await report(rep, "user", author.user.id);
      expect((await resolve(boss, "user", author.user.id, "remove")).status).toBe(400);
      expect((await resolve(boss, "user", author.user.id, "suspend")).status).toBe(200);
      expect((await M.User.findById(author.user.id)).suspendedAt).toBeInstanceOf(Date);
    });

    it("refuses to suspend an administrator or oneself, and a suspension with nobody to suspend", async () => {
      const boss = await makeAdmin();
      const second = await makeAdmin("second");
      const rep = await signup(app, "rep1");
      const own = await M.Post.create({ author: boss.user.id, content: "mine" });
      const theirs = await M.Post.create({ author: second.user.id, content: "theirs" });
      await report(rep, "post", own._id);
      await report(rep, "post", theirs._id);
      expect((await resolve(boss, "post", own._id, "suspend")).status).toBe(400);
      expect((await resolve(boss, "post", theirs._id, "suspend")).status).toBe(400);
      expect(await M.User.countDocuments({ suspendedAt: { $ne: null } })).toBe(0);
      expect(await M.Report.countDocuments({ status: "open" })).toBe(2); // nothing was half-done
      await M.Post.updateOne({ _id: own._id }, { $set: { author: "5f1d7f3b8f1d7f3b8f1d7f3b" } });
      expect((await resolve(boss, "post", own._id, "suspend")).status).toBe(400);
    });

    it("can still dismiss, or remove, something whose author has gone", async () => {
      const boss = await makeAdmin();
      const rep = await signup(app, "rep1");
      const post = await M.Post.create({ author: "5f1d7f3b8f1d7f3b8f1d7f3b", content: "orphan" });
      await report(rep, "post", post._id);
      expect((await resolve(boss, "post", post._id, "remove")).status).toBe(200);
      expect(await M.Post.countDocuments()).toBe(0);
    });

    it("checks what is asked: the action, the thing, the note, and that there is something open", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const post = await M.Post.create({ author: author.user.id, content: "x" });
      await report(rep, "post", post._id);
      expect((await resolve(boss, "post", post._id, "delete-everything")).status).toBe(400);
      expect((await resolve(boss, "spaceship", post._id, "dismiss")).status).toBe(400);
      expect((await resolve(boss, "post", "not-an-id", "dismiss")).status).toBe(400);
      expect((await resolve(boss, "post", post._id, "dismiss", "x".repeat(501))).status).toBe(400);
      expect((await resolve(boss, "post", "5f1d7f3b8f1d7f3b8f1d7f3b", "dismiss")).status).toBe(404);
      expect((await resolve(boss, "post", post._id, "dismiss")).status).toBe(200);
      expect((await resolve(boss, "post", post._id, "dismiss")).status).toBe(404); // already handled
    });

    it("closes every open report about the thing at once, and thanks each reporter once", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const r1 = await signup(app, "rep1");
      const r2 = await signup(app, "rep2");
      const post = await M.Post.create({ author: author.user.id, content: "x" });
      await report(r1, "post", post._id);
      await report(r2, "post", post._id);
      await resolve(boss, "post", post._id, "remove");
      expect(await M.Report.countDocuments({ status: "open" })).toBe(0);
      expect(await notesOf(r1, "report_resolved")).toHaveLength(1);
      expect(await notesOf(r2, "report_resolved")).toHaveLength(1);
      expect((await boss.agent.get("/api/admin/actions")).body.actions[0].reportCount).toBe(2);
    });

    it("lets a later report about something already handled start a new case", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const post = await M.Post.create({ author: author.user.id, content: "x" });
      await report(rep, "post", post._id);
      await resolve(boss, "post", post._id, "dismiss");
      expect((await report(rep, "post", post._id, "again")).status).toBe(201);
      expect((await queue(boss)).cases).toHaveLength(1);
    });
  });

  describe("a suspended account", () => {
    async function suspended() {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const friend = await signup(app, "friend");
      await author.agent.patch("/api/profiles/me").send({ tags: ["potter"], bio: "I make pots" });
      const post = await M.Post.create({ author: author.user.id, content: "bad" });
      await report(rep, "post", post._id);
      await resolve(boss, "post", post._id, "suspend", "spam");
      return { boss, author, rep, friend };
    }

    it("can't sign in with the right password, and learns nothing with the wrong one", async () => {
      const { author } = await suspended();
      const right = await login(author.email);
      expect(right.status).toBe(403);
      expect(right.body.code).toBe("account_suspended");
      expect(right.headers["set-cookie"]).toBeUndefined();
      expect((await login(author.email, "wrong-password")).status).toBe(401);
      expect((await login("nobody@example.com", "wrong-password")).status).toBe(401);
    });

    it("loses the sessions it already had", async () => {
      const { author } = await suspended();
      const res = await author.agent.get("/api/auth/me");
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("account_suspended");
      expect((await author.agent.post("/api/posts").send({ content: "still here?" })).status).toBe(403);
    });

    it("has no profile, and is left out of search, discovery and tags", async () => {
      const { friend } = await suspended();
      expect((await friend.agent.get("/api/profiles/author")).status).toBe(404);
      expect((await request(app).get("/api/profiles/author")).status).toBe(404);
      expect((await friend.agent.get("/api/profiles?search=author")).body.users).toEqual([]);
      expect((await friend.agent.get("/api/profiles/discover?tag=potter")).body.users).toEqual([]);
      expect((await friend.agent.get("/api/profiles/tags")).body.tags).toEqual([]);
      expect((await friend.agent.get("/api/media/user/author")).status).toBe(404);
    });

    it("is listed for administrators, with the moderator's note, and can be let back in", async () => {
      const { boss, author, friend } = await suspended();
      const list = (await boss.agent.get("/api/admin/suspended")).body.users;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ note: "spam" });
      expect(list[0].user.username).toBe("author");
      expect((await boss.agent.post(`/api/admin/users/${author.user.id}/unsuspend`)).status).toBe(204);
      expect((await boss.agent.get("/api/admin/suspended")).body.users).toEqual([]);
      expect((await login(author.email)).status).toBe(200);
      expect((await friend.agent.get("/api/profiles/author")).status).toBe(200);
      expect((await boss.agent.post(`/api/admin/users/${author.user.id}/unsuspend`)).status).toBe(404); // not suspended any more
      expect((await boss.agent.post("/api/admin/users/not-an-id/unsuspend")).status).toBe(404);
      const actions = (await boss.agent.get("/api/admin/actions")).body.actions;
      expect(actions.map((a) => a.action)).toEqual(["unsuspended", "suspended"]);
    });

    it("keeps the suspension note away from everyone but administrators", async () => {
      const { friend } = await suspended();
      expect(JSON.stringify((await friend.agent.get("/api/profiles?search=rep")).body)).not.toContain("spam");
      expect((await friend.agent.get("/api/admin/suspended")).status).toBe(404);
    });
  });

  describe("the record of decisions", () => {
    it("lists them newest first with who decided and about whom, twenty a page, and never the removed content", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      for (let i = 0; i < 22; i++) {
        const post = await M.Post.create({ author: author.user.id, content: `secret text ${i}` });
        await report(rep, "post", post._id);
        await resolve(boss, "post", post._id, i % 2 ? "remove" : "dismiss", `note ${i}`);
        if (i === 10) await M.Report.deleteMany({}); // keeps the hourly report limit out of the way
      }
      const first = (await boss.agent.get("/api/admin/actions")).body;
      expect(first.actions).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(first.actions[0]).toMatchObject({ note: "note 21", action: "removed" });
      expect(first.actions[0].admin.username).toBe("boss");
      expect(first.actions[0].subject.username).toBe("author");
      expect(JSON.stringify(first)).not.toContain("secret text");
      expect((await boss.agent.get("/api/admin/actions?page=2")).body.actions).toHaveLength(2);
    });
  });

  describe("accounts going away", () => {
    it("deletes the reports about someone who leaves, and still lets the decision record stand without their content", async () => {
      const boss = await makeAdmin();
      const author = await signup(app, "author");
      const rep = await signup(app, "rep1");
      const post = await M.Post.create({ author: author.user.id, content: "x" });
      await report(rep, "post", post._id);
      expect((await author.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect((await queue(boss)).cases).toEqual([]);
      expect(await M.Report.countDocuments()).toBe(0);
    });
  });
});
