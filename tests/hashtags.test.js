import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { MAX_TAGS, hashtagsIn, normalizeTag } from "../utils/hashtags.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.114.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("finding #hashtags in text", () => {
  it("finds tags that start a word, lower-cased, each once, in order", () => {
    expect(hashtagsIn("New #Ceramics and #glaze_tips today, more #ceramics")).toEqual(["ceramics", "glaze_tips"]);
    expect(hashtagsIn("#one\n#two")).toEqual(["one", "two"]);
    expect(hashtagsIn("(#art) and \"#music\"!")).toEqual(["art", "music"]);
  });
  it("works for tags written in Spanish and Arabic", () => {
    expect(hashtagsIn("Mi #cerámica y #Año2026")).toEqual(["cerámica", "año2026"]);
    expect(hashtagsIn("أحب #الخزف و #فن")).toEqual(["الخزف", "فن"]);
  });
  it("ignores numbers, entities, glued words, runs of #, a bare # and anything too short or too long", () => {
    for (const text of ["issue #12", "&#39;quoted&#39;", "abc#def", "##double", "#", "# space", "#a", "no tags", "", null, undefined, 5, {}]) expect(hashtagsIn(text), String(text)).toEqual([]);
    expect(hashtagsIn(`#${"a".repeat(31)}`)).toEqual([]);
    expect(hashtagsIn(`#${"a".repeat(30)}`)).toHaveLength(1);
  });
  it("counts at most ten tags", () => {
    const many = hashtagsIn(Array.from({ length: 15 }, (_, i) => `#tag${String.fromCharCode(97 + i)}`).join(" "));
    expect(many).toHaveLength(MAX_TAGS);
  });
  it("turns what was asked for into a tag, or nothing", () => {
    expect(normalizeTag("#Ceramics")).toBe("ceramics");
    expect(normalizeTag(" ceramics ")).toBe("ceramics");
    for (const bad of ["", "#", "a", "12", "two words", "<script>", "#" + "a".repeat(31), null, 5, undefined]) expect(normalizeTag(bad), String(bad)).toBeNull();
  });
});

describe("hashtags and Explore", () => {
  let app, Post, MediaItem, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ Post } = await import("../models/Post.js"));
    ({ MediaItem } = await import("../models/MediaItem.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const post = (who, content) => who.agent.post("/api/posts").send({ content });
  const piece = (who, caption, n = 1) => who.agent.post("/api/media").send({ type: "image", url: `https://img.example.com/${who.user.username}-${n}.png`, caption });
  const explore = (agent, query = "") => agent.get(`/api/explore${query}`);

  describe("tags are worked out from the words", () => {
    it("on a new post, on an edit, and on a caption", async () => {
      const alice = await signup(app, "alice");
      const made = await post(alice, "Throwing #pots all day");
      expect((await Post.findById(made.body.post.id)).tags).toEqual(["pots"]);
      await alice.agent.patch(`/api/posts/${made.body.post.id}`).send({ content: "Glazing #Pots and #kilns" });
      expect((await Post.findById(made.body.post.id)).tags).toEqual(["pots", "kilns"]);
      const p = await piece(alice, "A #vase for #spring");
      expect((await MediaItem.findById(p.body.mediaItem.id)).tags).toEqual(["vase", "spring"]);
      await alice.agent.patch(`/api/media/${p.body.mediaItem.id}`).send({ caption: null });
      expect((await MediaItem.findById(p.body.mediaItem.id)).tags).toEqual([]);
    });
    it("older posts and pieces get theirs when the server starts, once", async () => {
      const alice = await signup(app, "alice");
      const made = await post(alice, "An old #post");
      const p = await piece(alice, "An old #piece");
      await Post.collection.updateOne({ _id: new (await import("mongoose")).default.Types.ObjectId(made.body.post.id) }, { $unset: { tags: "" } });
      await MediaItem.collection.updateOne({ _id: new (await import("mongoose")).default.Types.ObjectId(p.body.mediaItem.id) }, { $unset: { tags: "" } });
      const { backfillHashtags } = await import("../services/hashtags.js");
      expect(await backfillHashtags()).toBe(2);
      expect((await Post.findById(made.body.post.id)).tags).toEqual(["post"]);
      expect((await MediaItem.findById(p.body.mediaItem.id)).tags).toEqual(["piece"]);
      expect(await backfillHashtags()).toBe(0);
    });
  });

  describe("Explore", () => {
    it("is open to people who aren't signed in, newest first, and says which posts are whose", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      await post(alice, "First");
      await post(bob, "Second");
      const res = await explore(request(app));
      expect(res.status).toBe(200);
      expect(res.body.posts.map((p) => p.content)).toEqual(["Second", "First"]);
      expect(res.body.posts[0].author.username).toBe("bobby");
      expect(JSON.stringify(res.body)).not.toMatch(/email|passwordHash/);
    });
    it("finds the posts or the pieces about one tag, whatever its case", async () => {
      const alice = await signup(app, "alice");
      await post(alice, "About #Pots");
      await post(alice, "About #glass");
      await piece(alice, "A #pots piece", 1);
      await piece(alice, "A #glass piece", 2);
      expect((await explore(request(app), "?tag=%23Pots")).body.posts.map((p) => p.content)).toEqual(["About #Pots"]);
      expect((await explore(request(app), "?tag=pots&type=pieces")).body.pieces.map((p) => p.item.caption)).toEqual(["A #pots piece"]);
      expect((await explore(request(app), "?tag=pots")).body.tag).toBe("pots");
      expect((await explore(request(app), "?tag=nothing")).body.posts).toEqual([]);
    });
    it("refuses something that can't be a tag", async () => {
      for (const bad of ["a", "two%20words", "%3Cscript%3E", "12"]) {
        const res = await explore(request(app), `?tag=${bad}`);
        expect(res.status, bad).toBe(400);
        expect(res.body.error).toBe("That isn't a topic you can search for");
      }
    });
    it("leaves out private, suspended and blocked people, and shows a person's own posts to them", async () => {
      const [pub, priv, gone, blk, viewer] = [await signup(app, "pubone"), await signup(app, "privone"), await signup(app, "suspone"), await signup(app, "blockone"), await signup(app, "viewer")];
      for (const who of [pub, priv, gone, blk]) {
        await post(who, `Post by ${who.user.username} #topic`);
        await piece(who, `Piece by ${who.user.username} #topic`);
      }
      await priv.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await User.updateOne({ username: "suspone" }, { suspendedAt: new Date() });
      await viewer.agent.post("/api/users/blockone/block");
      const posts = (await explore(viewer.agent, "?tag=topic")).body.posts.map((p) => p.author.username);
      expect(posts).toEqual(["pubone"]);
      expect((await explore(viewer.agent, "?tag=topic&type=pieces")).body.pieces.map((p) => p.owner.username)).toEqual(["pubone"]);
      expect((await explore(request(app), "?tag=topic")).body.posts.map((p) => p.author.username).sort()).toEqual(["blockone", "pubone"]);
    });
    it("pages through with a cursor", async () => {
      const alice = await signup(app, "alice");
      // made directly: posting through the site is limited to 20 in ten minutes
      for (let i = 0; i < 23; i++) await Post.create({ author: alice.user.id, content: `Post ${i} #many` });
      const first = (await explore(request(app), "?tag=many")).body;
      expect(first.posts).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      const second = (await explore(request(app), `?tag=many&before=${first.next}`)).body;
      expect(second.posts).toHaveLength(3);
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.posts, ...second.posts].map((p) => p.id)).size).toBe(23);
    });
    it("carries what a post needs to be drawn: comment count and reactions", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const made = await post(alice, "Reactions #here");
      await bob.agent.post(`/api/posts/${made.body.post.id}/comments`).send({ content: "nice" });
      await bob.agent.put(`/api/posts/${made.body.post.id}/reaction`).send({ emoji: "love" });
      const res = (await explore(bob.agent, "?tag=here")).body.posts[0];
      expect(res.commentCount).toBe(1);
      expect(res.reactions.total).toBe(1);
      expect(res.reactions.mine).toBe("love");
    });
  });

  describe("trending", () => {
    it("lists the topics of this week with the most people first, counting a person once per tag", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bobby");
      const cara = await signup(app, "carla");
      await post(alice, "#pots #pots");
      await post(alice, "#pots again");
      await post(alice, "#glass");
      await post(bob, "#pots");
      await piece(cara, "A #glass piece");
      await post(cara, "#glass too");
      const res = await request(app).get("/api/explore/trending");
      expect(res.status).toBe(200);
      expect(res.body.tags[0]).toMatchObject({ tag: "glass", people: 2 });
      expect(res.body.tags[1]).toMatchObject({ tag: "pots", people: 2 });
      expect(res.body.tags.find((t) => t.tag === "pots").uses).toBe(3);
      expect(res.body.days).toBe(7);
    });
    it("leaves out private and suspended people, and what is older than a week", async () => {
      const alice = await signup(app, "alice");
      const priv = await signup(app, "private1");
      const gone = await signup(app, "suspone");
      await post(alice, "#shown");
      await post(priv, "#hidden");
      await post(gone, "#banned");
      const old = await post(alice, "#stale");
      await priv.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await User.updateOne({ username: "suspone" }, { suspendedAt: new Date() });
      await Post.collection.updateOne({ _id: new (await import("mongoose")).default.Types.ObjectId(old.body.post.id) }, { $set: { createdAt: new Date(Date.now() - 10 * 86_400_000) } });
      const res = await request(app).get("/api/explore/trending");
      expect(res.body.tags.map((t) => t.tag)).toEqual(["shown"]);
    });
    it("is empty when nobody has used a tag", async () => {
      const alice = await signup(app, "alice");
      await post(alice, "No tags here");
      expect((await request(app).get("/api/explore/trending")).body.tags).toEqual([]);
    });
  });
});
