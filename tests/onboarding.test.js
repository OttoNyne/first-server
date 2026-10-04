import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.${120 + Math.floor(signups / 250)}.${(signups++ % 250) + 1}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name });
  return { agent, user: res.body.user };
}
async function befriend(a, b) {
  const sent = await a.agent.post(`/api/friends/request/${b.user.username}`);
  await b.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
}

describe("the getting-started checklist", () => {
  let app, User;
  beforeAll(async () => {
    await connectTestDb();
    ({ app } = await import("../app.js"));
    ({ User } = await import("../models/User.js"));
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const state = async (who) => (await who.agent.get("/api/onboarding")).body;
  const doneKeys = (s) => s.steps.filter((x) => x.done).map((x) => x.key);

  it("needs a sign-in", async () => {
    expect((await request(app).get("/api/onboarding")).status).toBe(401);
    expect((await request(app).post("/api/onboarding/dismiss")).status).toBe(401);
  });

  it("starts with nothing done, in a fixed order, and is shown to a new account", async () => {
    const alice = await signup(app, "alice");
    const s = await state(alice);
    expect(s.steps.map((x) => x.key)).toEqual(["email", "avatar", "bio", "portfolio", "friend", "post"]);
    expect(doneKeys(s)).toEqual([]);
    expect(s).toMatchObject({ allDone: false, dismissed: false, show: true });
  });

  it("ticks each step from what the person has really done, and not before", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");

    await alice.agent.patch("/api/profiles/me").send({ avatarUrl: "https://images.example.com/a.jpg" });
    expect(doneKeys(await state(alice))).toEqual(["avatar"]);

    await alice.agent.patch("/api/profiles/me").send({ bio: "   " });
    expect(doneKeys(await state(alice))).toEqual(["avatar"]); // a blank bio doesn't count
    await alice.agent.patch("/api/profiles/me").send({ bio: "I paint" });
    expect(doneKeys(await state(alice))).toEqual(["avatar", "bio"]);

    await alice.agent.post("/api/media").send({ type: "image", url: "https://images.example.com/p.jpg" });
    expect(doneKeys(await state(alice))).toEqual(["avatar", "bio", "portfolio"]);

    const sent = await alice.agent.post(`/api/friends/request/${bob.user.username}`);
    expect(doneKeys(await state(alice))).toEqual(["avatar", "bio", "portfolio"]); // a request isn't a friend yet
    await bob.agent.post(`/api/friends/accept/${sent.body.friendship._id}`);
    expect(doneKeys(await state(alice))).toEqual(["avatar", "bio", "portfolio", "friend"]);

    await alice.agent.post("/api/posts").send({ content: "Hello world" });
    expect(doneKeys(await state(alice))).toEqual(["avatar", "bio", "portfolio", "friend", "post"]);

    await User.updateOne({ _id: alice.user.id }, { $set: { emailVerified: true } });
    const done = await state(alice);
    expect(doneKeys(done)).toHaveLength(6);
    expect(done).toMatchObject({ allDone: true, show: false });
  });

  it("looks only at the person's own account", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    await bob.agent.patch("/api/profiles/me").send({ bio: "Bob's bio" });
    await bob.agent.post("/api/posts").send({ content: "Bob posts" });
    expect(doneKeys(await state(alice))).toEqual([]);
    expect(doneKeys(await state(bob))).toEqual(["bio", "post"]);
  });

  it("counts a friendship in either direction", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    await befriend(bob, alice); // bob asked, alice accepted
    expect(doneKeys(await state(alice))).toEqual(["friend"]);
    expect(doneKeys(await state(bob))).toEqual(["friend"]);
  });

  it("is not shown for an account older than two weeks, but the steps are still right", async () => {
    const alice = await signup(app, "alice");
    await User.collection.updateOne({ username: "alice" }, { $set: { createdAt: new Date(Date.now() - 15 * 86_400_000) } });
    const s = await state(alice);
    expect(s.show).toBe(false);
    expect(s.allDone).toBe(false);
    await User.collection.updateOne({ username: "alice" }, { $set: { createdAt: new Date(Date.now() - 13 * 86_400_000) } });
    expect((await state(alice)).show).toBe(true);
  });

  it("can be hidden for good, and saying so twice changes nothing", async () => {
    const alice = await signup(app, "alice");
    expect((await alice.agent.post("/api/onboarding/dismiss")).status).toBe(204);
    const first = (await User.findById(alice.user.id)).onboardingDismissedAt;
    expect(first).toBeInstanceOf(Date);
    expect((await alice.agent.post("/api/onboarding/dismiss")).status).toBe(204);
    expect((await User.findById(alice.user.id)).onboardingDismissedAt.getTime()).toBe(first.getTime());
    expect(await state(alice)).toMatchObject({ dismissed: true, show: false, allDone: false });
  });

  it("hides one person's checklist without touching anyone else's", async () => {
    const alice = await signup(app, "alice");
    const bob = await signup(app, "bobby");
    await alice.agent.post("/api/onboarding/dismiss");
    expect((await state(bob)).show).toBe(true);
  });

  it("doesn't put the hidden-checklist time on profiles", async () => {
    const alice = await signup(app, "alice");
    await alice.agent.post("/api/onboarding/dismiss");
    const me = (await alice.agent.get("/api/profiles/alice")).body.user;
    expect(JSON.stringify(me)).not.toContain("onboardingDismissedAt");
  });

  it("is off for accounts that predate the setting only if they are old, and shown if they're new", async () => {
    const alice = await signup(app, "alice");
    await User.collection.updateOne({ username: "alice" }, { $unset: { onboardingDismissedAt: "" } });
    expect((await state(alice)).show).toBe(true);
  });
});
