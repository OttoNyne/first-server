import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";
import { PROMPTS, previousWeek, promptFor, weekFromKey, weekOf } from "../utils/challenges.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.111.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}

describe("the weeks and their prompts", () => {
  it("names a week by its Monday-to-Sunday ISO week, in UTC", () => {
    const w = weekOf(new Date("2026-10-08T12:00:00Z"));
    expect(w.key).toBe("2026-W41");
    expect(w.start.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(weekOf(new Date("2026-10-11T23:59:59Z")).key).toBe("2026-W41"); // Sunday night is still that week
    expect(weekOf(new Date("2026-10-12T00:00:00Z")).key).toBe("2026-W42");
  });
  it("gets the ends of years right", () => {
    expect(weekOf(new Date("2021-01-03T10:00:00Z")).key).toBe("2020-W53");
    expect(weekOf(new Date("2024-12-30T10:00:00Z")).key).toBe("2025-W01");
    expect(weekOf(new Date("2026-01-01T10:00:00Z")).key).toBe("2026-W01");
    expect(previousWeek(new Date("2026-01-05T10:00:00Z")).key).toBe("2026-W01"); // 5 January is a Monday: the week before began on 29 December
    expect(previousWeek(new Date("2025-12-29T10:00:00Z")).key).toBe("2025-W52");
  });
  it("knows which keys are real weeks", () => {
    expect(weekFromKey("2026-W41").start.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(weekFromKey("2026-W53")?.key).toBe("2026-W53");
    for (const bad of ["2025-W53", "2026-W54", "2026-W00", "2026-41", "abc", "", null, 5, "2026-W4", "1999-W10"]) expect(weekFromKey(bad), String(bad)).toBeNull();
  });
  it("picks a prompt from the week, in the language asked for, and it changes week to week", () => {
    const a = weekFromKey("2026-W41");
    const b = weekFromKey("2026-W42");
    expect(PROMPTS.length).toBeGreaterThanOrEqual(20);
    expect(promptFor(a)).toBe(promptFor(a, "en"));
    expect(promptFor(a, "es")).not.toBe(promptFor(a, "en"));
    expect(promptFor(a, "klingon")).toBe(promptFor(a, "en"));
    expect(promptFor(a)).not.toBe(promptFor(b));
    for (const p of PROMPTS) expect([p.en, p.es, p.ar].every((x) => typeof x === "string" && x.length > 0 && x.length <= 40)).toBe(true);
    expect(new Set(PROMPTS.map((p) => p.en)).size).toBe(PROMPTS.length);
  });
});

describe("the weekly challenge", () => {
  let app, ChallengeEntry, User, MediaItem;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ ChallengeEntry } = await import("../models/ChallengeEntry.js"));
    ({ User } = await import("../models/User.js"));
    ({ MediaItem } = await import("../models/MediaItem.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const piece = async (who, n = 1) => (await who.agent.post("/api/media").send({ type: "image", url: `https://img.example.com/${who.user.username}-${n}.png`, caption: `piece ${n}` })).body.mediaItem;
  const enter = (who, itemId) => who.agent.post("/api/challenges/current/entry").send({ itemId });
  const gallery = (agent, query = "") => agent.get(`/api/challenges/${weekOf().key}/entries${query}`);

  describe("this week", () => {
    it("anyone can see the prompt, last week's, and how many have entered", async () => {
      const res = await request(app).get("/api/challenges/current");
      expect(res.status).toBe(200);
      expect(res.body.week).toMatchObject({ key: weekOf().key, prompt: promptFor(weekOf()) });
      expect(res.body.previous.key).toBe(previousWeek().key);
      expect(res.body.entryCount).toBe(0);
      expect(res.body.mine).toBeNull();
    });
    it("comes in the language asked for, and English for one that isn't ours", async () => {
      expect((await request(app).get("/api/challenges/current?lang=es")).body.week.prompt).toBe(promptFor(weekOf(), "es"));
      expect((await request(app).get("/api/challenges/current?lang=ar")).body.week.prompt).toBe(promptFor(weekOf(), "ar"));
      expect((await request(app).get("/api/challenges/current?lang=zz")).body.week.prompt).toBe(promptFor(weekOf(), "en"));
    });
  });

  describe("entering", () => {
    it("needs a sign-in", async () => {
      expect((await request(app).post("/api/challenges/current/entry").send({ itemId: "x" })).status).toBe(401);
      expect((await request(app).delete("/api/challenges/current/entry")).status).toBe(401);
    });
    it("takes one of your own pieces, shows it as yours this week, and counts it", async () => {
      const alice = await signup(app, "alice");
      const p = await piece(alice);
      const res = await enter(alice, p.id);
      expect(res.status).toBe(201);
      expect(res.body.entry.item.id).toBe(p.id);
      const now = await alice.agent.get("/api/challenges/current");
      expect(now.body.entryCount).toBe(1);
      expect(now.body.mine.item.id).toBe(p.id);
      expect((await request(app).get("/api/challenges/current")).body.mine).toBeNull(); // only the signed-in person sees theirs
    });
    it("won't take a piece that isn't yours, or one that isn't there", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      const p = await piece(bob);
      expect((await enter(alice, p.id)).status).toBe(404);
      for (const bad of [undefined, "", "nope", 5, "0123456789abcdef01234567"]) expect((await enter(alice, bad)).status, String(bad)).toBeGreaterThanOrEqual(400);
      expect(await ChallengeEntry.countDocuments()).toBe(0);
    });
    it("is one entry a week; withdrawing it lets you enter a different piece", async () => {
      const alice = await signup(app, "alice");
      const one = await piece(alice, 1);
      const two = await piece(alice, 2);
      expect((await enter(alice, one.id)).status).toBe(201);
      const again = await enter(alice, two.id);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("You've already entered this week's challenge");
      expect((await alice.agent.delete("/api/challenges/current/entry")).status).toBe(204);
      expect((await alice.agent.get("/api/challenges/current")).body.mine).toBeNull();
      expect((await enter(alice, two.id)).status).toBe(201);
      expect((await alice.agent.delete("/api/challenges/current/entry")).status).toBe(204);
      const none = await alice.agent.delete("/api/challenges/current/entry");
      expect(none.status).toBe(404);
      expect(none.body.error).toBe("You haven't entered this week's challenge");
    });
    it("is for public profiles, because the gallery is open to everyone", async () => {
      const alice = await signup(app, "alice");
      const p = await piece(alice);
      await alice.agent.patch("/api/profiles/me").send({ isPrivate: true });
      const res = await enter(alice, p.id);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Make your profile public/);
    });
  });

  describe("the gallery", () => {
    it("is open to people who aren't signed in, newest first, with who made each piece", async () => {
      const alice = await signup(app, "alice");
      const bob = await signup(app, "bob");
      await enter(alice, (await piece(alice)).id);
      await enter(bob, (await piece(bob)).id);
      const res = await gallery(request(app));
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.entries.map((e) => e.owner.username)).toEqual(["bob", "alice"]);
      expect(res.body.entries[0]).toMatchObject({ item: { url: "https://img.example.com/bob-1.png", caption: "piece 1" }, owner: { displayName: "bob" } });
      expect(res.body.week.prompt).toBe(promptFor(weekOf()));
      expect(JSON.stringify(res.body)).not.toMatch(/email|passwordHash/);
    });
    it("can be ordered by reactions, and paged", async () => {
      const people = [];
      for (const n of ["ann", "ben", "cat"]) people.push(await signup(app, n));
      const pieces = [];
      for (const who of people) {
        const p = await piece(who);
        pieces.push(p);
        await enter(who, p.id);
      }
      const fan1 = await signup(app, "fanone");
      const fan2 = await signup(app, "fantwo");
      await fan1.agent.put(`/api/media/${pieces[0].id}/reaction`).send({ emoji: "love" });
      await fan1.agent.put(`/api/media/${pieces[1].id}/reaction`).send({ emoji: "love" });
      await fan2.agent.put(`/api/media/${pieces[1].id}/reaction`).send({ emoji: "love" });
      const top = await gallery(request(app), "?sort=top");
      expect(top.body.entries.map((e) => e.owner.username)).toEqual(["ben", "ann", "cat"]);
      expect(top.body.entries[0].item.reactions.total).toBe(2);
      const first = await gallery(request(app), "?limit=2");
      expect(first.body.entries).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);
      const second = await gallery(request(app), "?limit=2&page=2");
      expect(second.body.entries).toHaveLength(1);
      expect(second.body.hasMore).toBe(false);
    });
    it("leaves out private, suspended and blocked people, and a piece that has gone", async () => {
      const [a, b, c, d] = [await signup(app, "pubone"), await signup(app, "privone"), await signup(app, "suspone"), await signup(app, "blockone")];
      const ids = [];
      for (const who of [a, b, c, d]) {
        const p = await piece(who);
        ids.push(p.id);
        await enter(who, p.id);
      }
      await b.agent.patch("/api/profiles/me").send({ isPrivate: true });
      await User.updateOne({ username: "suspone" }, { suspendedAt: new Date() });
      const viewer = await signup(app, "viewer");
      await viewer.agent.post("/api/users/blockone/block");
      const res = await gallery(viewer.agent);
      expect(res.body.entries.map((e) => e.owner.username)).toEqual(["pubone"]);
      const stranger = await gallery(request(app));
      expect(stranger.body.entries.map((e) => e.owner.username).sort()).toEqual(["blockone", "pubone"]);
      await MediaItem.deleteOne({ _id: ids[0] });
      expect((await gallery(request(app))).body.entries.map((e) => e.owner.username)).toEqual(["blockone"]);
    });
    it("shows an earlier week, and says there is no such week for a future one or a made-up key", async () => {
      const alice = await signup(app, "alice");
      const p = await piece(alice);
      const past = previousWeek();
      await ChallengeEntry.create({ week: past.key, user: alice.user.id, item: p.id });
      const res = await request(app).get(`/api/challenges/${past.key}/entries?sort=top&limit=3`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.week.prompt).toBe(promptFor(past));
      const future = weekOf(new Date(Date.now() + 14 * 86_400_000));
      expect((await request(app).get(`/api/challenges/${future.key}/entries`)).status).toBe(404);
      expect((await request(app).get("/api/challenges/nonsense/entries")).status).toBe(404);
      expect((await request(app).get("/api/challenges/2025-W53/entries")).status).toBe(404);
    });
    it("lets the same person enter again the next week (a past entry doesn't block this one)", async () => {
      const alice = await signup(app, "alice");
      const p = await piece(alice);
      await ChallengeEntry.create({ week: previousWeek().key, user: alice.user.id, item: p.id });
      expect((await enter(alice, p.id)).status).toBe(201);
    });
  });

  describe("tidying up", () => {
    it("deleting the piece takes the entry with it", async () => {
      const alice = await signup(app, "alice");
      const p = await piece(alice);
      await enter(alice, p.id);
      expect((await alice.agent.delete(`/api/media/${p.id}`)).status).toBe(204);
      expect(await ChallengeEntry.countDocuments()).toBe(0);
      expect((await alice.agent.get("/api/challenges/current")).body.mine).toBeNull();
    });
    it("deleting the account takes the entries, and the data download lists them", async () => {
      const alice = await signup(app, "alice");
      const p = await piece(alice);
      await enter(alice, p.id);
      const download = await alice.agent.post("/api/profiles/me/export").send({ password: "password123" });
      expect(download.status).toBe(200);
      const text = download.text;
      expect(text).toContain("challengeEntries");
      expect(text).toContain(weekOf().key);
      expect((await alice.agent.delete("/api/profiles/me").send({ password: "password123" })).status).toBe(204);
      expect(await ChallengeEntry.countDocuments()).toBe(0);
    });
  });
});
