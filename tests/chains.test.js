import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

let signups = 0;
async function signup(app, name) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.127.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "Passw0rd!x", displayName: name.toUpperCase(), acceptTerms: true, confirmAge: true });
  return { agent, user: res.body.user };
}

/** A PNG that says it is `width` × `height` (the server never decodes a drawing, so the first chunk is all that has to be real). */
function fakePng(width = 1200, height = 400, extra = 64) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(extra, 7)]);
}
const section = (marker = 1) => fakePng(1200, 400, 64 + marker);
const edge = () => fakePng(1200, 40, 16);

describe("exquisite-corpse chains", () => {
  let app, M;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    M = {
      User: (await import("../models/User.js")).User,
      Chain: (await import("../models/Chain.js")).Chain,
      ChainSection: (await import("../models/ChainSection.js")).ChainSection,
      Notification: (await import("../models/Notification.js")).Notification,
      Report: (await import("../models/Report.js")).Report,
      RateLimitHit: (await import("../models/RateLimitHit.js")).RateLimitHit,
    };
  });
  beforeEach(clearTestDb);
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
    await disconnectTestDb();
  });

  const start = (who, { prompt, sectionBuf = section(), edgeBuf = edge() } = {}) => {
    let r = who.agent.post("/api/chains");
    if (prompt !== undefined) r = r.field("prompt", prompt);
    if (sectionBuf) r = r.attach("section", sectionBuf, { filename: "section.png", contentType: "image/png" });
    if (edgeBuf) r = r.attach("edge", edgeBuf, { filename: "edge.png", contentType: "image/png" });
    return r;
  };
  const claim = (who, id) => who.agent.post(`/api/chains/${id}/claim`);
  const add = (who, id, { sectionBuf = section(2), edgeBuf = edge() } = {}) => {
    let r = who.agent.post(`/api/chains/${id}/sections`);
    if (sectionBuf) r = r.attach("section", sectionBuf, { filename: "section.png", contentType: "image/png" });
    if (edgeBuf) r = r.attach("edge", edgeBuf, { filename: "edge.png", contentType: "image/png" });
    return r;
  };
  const open = async (who) => (await who.agent.get("/api/chains/open")).body.chains;
  const begin = async (who, prompt = "A very tall cat") => (await start(who, { prompt })).body.chain.id;

  /** Three people draw a whole chain; returns the chain id. */
  async function finished(a, b, c, prompt = "A tall cat") {
    const id = await begin(a, prompt);
    await claim(b, id);
    await add(b, id);
    await claim(c, id);
    await add(c, id, { edgeBuf: null });
    return id;
  }

  describe("starting a chain", () => {
    it("is for people who are signed in", async () => {
      const res = await request(app).post("/api/chains").attach("section", section(), "s.png");
      expect(res.status).toBe(401);
    });

    it("makes a chain with its first part, and the prompt kept to one clean line", async () => {
      const ann = await signup(app, "ann");
      const res = await start(ann, { prompt: "  A   tall\ncat  " });
      expect(res.status).toBe(201);
      expect(res.body.chain).toMatchObject({ count: 1, parts: 3, nextPart: 2 });
      const chain = await M.Chain.findById(res.body.chain.id);
      expect(chain.prompt).toBe("A tall cat");
      expect(chain.status).toBe("open");
      expect(chain.contributors.map(String)).toEqual([ann.user.id]);
      const parts = await M.ChainSection.find({ chain: chain._id }).select("+png +edge");
      expect(parts).toHaveLength(1);
      expect(parts[0].index).toBe(0);
      expect(parts[0].png.length).toBeGreaterThan(30);
      expect(parts[0].edge.length).toBeGreaterThan(30);
    });

    it("needs the right pictures: a PNG of exactly the right size, with its edge, not too large", async () => {
      const ann = await signup(app, "ann");
      expect((await start(ann, { sectionBuf: null })).body.error).toBe("Draw something first");
      expect((await start(ann, { sectionBuf: Buffer.from("not a picture at all, just some words") })).body.error).toBe("That isn't a PNG picture");
      expect((await start(ann, { sectionBuf: fakePng(1200, 300) })).body.error).toBe("That drawing isn't the right size");
      expect((await start(ann, { sectionBuf: fakePng(1201, 400) })).status).toBe(400);
      expect((await start(ann, { edgeBuf: null })).status).toBe(400);
      expect((await start(ann, { edgeBuf: fakePng(1200, 41) })).body.error).toBe("That drawing isn't the right size");
      const big = await start(ann, { sectionBuf: fakePng(1200, 400, 600 * 1024) });
      expect(big.status).toBe(413);
      expect(big.body.error).toBe("That drawing is too large");
      expect(await M.Chain.countDocuments()).toBe(0);
    });

    it("keeps the idea to 100 characters", async () => {
      const ann = await signup(app, "ann");
      const res = await start(ann, { prompt: "x".repeat(101) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("100");
      expect((await start(ann, { prompt: "x".repeat(100) })).status).toBe(201);
    });

    it("is for public profiles only, since a finished chain is shown to everyone", async () => {
      const ann = await signup(app, "ann");
      await M.User.updateOne({ _id: ann.user.id }, { $set: { isPrivate: true } });
      const res = await start(ann);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("only public profiles");
    });

    it("lets one person have three chains waiting at once, and no more, and six started in a day", async () => {
      const ann = await signup(app, "ann");
      for (let i = 0; i < 3; i++) expect((await start(ann)).status).toBe(201);
      const res = await start(ann);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("3 chains waiting");
      await M.Chain.deleteMany({});
      await M.RateLimitHit.deleteMany({});
      for (let i = 0; i < 6; i++) {
        expect((await start(ann)).status).toBe(201);
        await M.Chain.deleteMany({});
      }
      expect((await start(ann)).status).toBe(429);
    });
  });

  describe("taking the next part", () => {
    it("shows waiting chains to others but not to the person who started them", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const id = await begin(ann);
      expect(await open(ann)).toEqual([]);
      const list = await open(ben);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id, prompt: "A very tall cat", count: 1, parts: 3, nextPart: 2, claimedByMe: false, edgeUrl: `/api/chains/${id}/edge` });
      // nothing about the pictures themselves is in the list
      expect(JSON.stringify(list)).not.toContain("section");
    });

    it("gives the part to one person at a time, and the same person may ask again", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await begin(ann);
      const first = await claim(ben, id);
      expect(first.status).toBe(200);
      expect(first.body.minutes).toBe(30);
      const again = await claim(ben, id);
      expect(again.status).toBe(200);
      expect(again.body.claimedUntil).toBe(first.body.claimedUntil);
      const taken = await claim(cat, id);
      expect(taken.status).toBe(409);
      expect(taken.body.error).toContain("Someone else is drawing");
      expect(await open(cat)).toEqual([]);
      expect((await open(ben))[0].claimedByMe).toBe(true);
    });

    it("lets two people asking at the same moment have only one winner", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await begin(ann);
      const [a, b] = await Promise.all([claim(ben, id), claim(cat, id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it("gives the part to someone else once the time has run out, or when it is given back", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await begin(ann);
      await claim(ben, id);
      await M.Chain.updateOne({ _id: id }, { $set: { claimUntil: new Date(Date.now() - 1000) } });
      expect((await open(cat))).toHaveLength(1);
      expect((await claim(cat, id)).status).toBe(200);
      expect((await claim(ben, id)).status).toBe(409);
      expect((await cat.agent.delete(`/api/chains/${id}/claim`)).status).toBe(204);
      expect((await claim(ben, id)).status).toBe(200);
      // giving back what isn't yours changes nothing
      await cat.agent.delete(`/api/chains/${id}/claim`);
      expect((await M.Chain.findById(id)).claimUser.toString()).toBe(ben.user.id);
    });

    it("is not for someone who already drew a part, a finished chain, a missing one, a private profile or a blocked person", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const dee = await signup(app, "dee");
      const id = await begin(ann);
      const own = await claim(ann, id);
      expect(own.status).toBe(403);
      expect(own.body.error).toContain("already drawn");
      expect((await claim(ben, "64b64b64b64b64b64b64b64b")).status).toBe(404);
      expect((await claim(ben, "nope")).status).toBe(404);
      await M.User.updateOne({ _id: ben.user.id }, { $set: { isPrivate: true } });
      expect((await claim(ben, id)).status).toBe(403);
      await M.User.updateOne({ _id: ben.user.id }, { $set: { isPrivate: false } });
      await dee.agent.post("/api/users/ann/block");
      expect((await claim(dee, id)).status).toBe(404);
      expect(await open(dee)).toEqual([]);
      const eve = await signup(app, "eve");
      const done = await finished(ann, ben, cat, "Another");
      expect((await claim(eve, done)).status).toBe(409);
    });

    it("limits how many parts a person takes in a day", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await begin(ann));
      await M.RateLimitHit.deleteMany({});
      for (let i = 0; i < 40; i++) await M.RateLimitHit.create({ key: `chain-claim:${ben.user.id}`, at: new Date(), expireAt: new Date(Date.now() + 3600_000) });
      const res = await claim(ben, ids[0]);
      expect(res.status).toBe(429);
    });
  });

  describe("the strip along the bottom", () => {
    it("is given only to the person drawing the next part", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await begin(ann);
      expect((await ben.agent.get(`/api/chains/${id}/edge`)).status).toBe(404);
      await claim(ben, id);
      const res = await ben.agent.get(`/api/chains/${id}/edge`).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.body.equals(edge())).toBe(true);
      expect((await cat.agent.get(`/api/chains/${id}/edge`)).status).toBe(404);
      expect((await ann.agent.get(`/api/chains/${id}/edge`)).status).toBe(404);
    });

    it("is also open to a moderator, who may need to see what was reported", async () => {
      const ann = await signup(app, "ann");
      const boss = await signup(app, "boss");
      await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
      const id = await begin(ann);
      expect((await boss.agent.get(`/api/chains/${id}/edge`)).status).toBe(200);
    });
  });

  describe("drawing a part", () => {
    it("needs the part to be taken first", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const id = await begin(ann);
      const res = await add(ben, id);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Take this part first");
      expect(await M.ChainSection.countDocuments({ chain: id })).toBe(1);
    });

    it("saves the part, uses up the claim and passes the chain on", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await begin(ann);
      await claim(ben, id);
      const res = await add(ben, id);
      expect(res.status).toBe(201);
      expect(res.body.chain).toMatchObject({ count: 2, complete: false, sections: [] });
      const chain = await M.Chain.findById(id);
      expect(chain.claimUser).toBeNull();
      expect(chain.contributors.map(String)).toEqual([ann.user.id, ben.user.id]);
      expect((await M.ChainSection.find({ chain: id }).sort({ index: 1 })).map((s) => String(s.author))).toEqual([ann.user.id, ben.user.id]);
      // the next person sees the new part's strip, and the one who drew it can't take another part
      expect((await open(cat))[0]).toMatchObject({ count: 2, nextPart: 3 });
      expect((await claim(ben, id)).status).toBe(403);
      expect((await add(ben, id)).status).toBe(409);
    });

    it("needs the strip for every part but the last", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await begin(ann);
      await claim(ben, id);
      expect((await add(ben, id, { edgeBuf: null })).status).toBe(400);
      expect((await add(ben, id, { sectionBuf: fakePng(10, 10) })).status).toBe(400);
      expect((await add(ben, id, { sectionBuf: null })).body.error).toBe("Draw something first");
      expect((await add(ben, id)).status).toBe(201);
      await claim(cat, id);
      // the last part needs no strip
      expect((await add(cat, id, { edgeBuf: null })).status).toBe(201);
    });

    it("finishes the chain with the last part, and tells the others who drew on it", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await finished(ann, ben, cat, "Three friends");
      const chain = await M.Chain.findById(id);
      expect(chain).toMatchObject({ status: "complete", count: 3 });
      expect(chain.completedAt).toBeTruthy();
      const told = await M.Notification.find({ type: "chain_done" });
      expect(told.map((n) => String(n.recipient)).sort()).toEqual([ann.user.id, ben.user.id].sort());
      expect(told[0].payload).toMatchObject({ chainId: id, prompt: "Three friends", actorId: cat.user.id });
      expect(await open(await signup(app, "dee"))).toEqual([]);
    });

    it("lets a claim run out: too late is too late", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const id = await begin(ann);
      await claim(ben, id);
      await M.Chain.updateOne({ _id: id }, { $set: { claimUntil: new Date(Date.now() - 1000) } });
      expect((await add(ben, id)).status).toBe(409);
    });

    it("counts a part once, however many times it is sent", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const id = await begin(ann);
      await claim(ben, id);
      const results = await Promise.all([add(ben, id), add(ben, id), add(ben, id)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect((await M.Chain.findById(id)).count).toBe(2);
      expect(await M.ChainSection.countDocuments({ chain: id })).toBe(2);
    });
  });

  describe("seeing a chain", () => {
    it("shows a finished chain with every part and who drew it, and a waiting one only as far along as it is", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const dee = await signup(app, "dee");
      const waitingId = await begin(dee, "Waiting");
      const id = await finished(ann, ben, cat, "Done");
      const body = (await dee.agent.get(`/api/chains/${id}`)).body.chain;
      expect(body).toMatchObject({ complete: true, prompt: "Done", count: 3, mine: false });
      expect(body.sections.map((s) => [s.index, s.author.username, s.imageUrl])).toEqual([
        [0, "ann", `/api/chains/${id}/sections/0/image`],
        [1, "ben", `/api/chains/${id}/sections/1/image`],
        [2, "cat", `/api/chains/${id}/sections/2/image`],
      ]);
      const waitingBody = (await ann.agent.get(`/api/chains/${waitingId}`)).body.chain;
      expect(waitingBody).toMatchObject({ complete: false, count: 1, sections: [], canDelete: false });
      expect((await dee.agent.get(`/api/chains/${waitingId}`)).body.chain.canDelete).toBe(true);
      expect((await ann.agent.get("/api/chains/64b64b64b64b64b64b64b64b")).status).toBe(404);
      expect((await ann.agent.get("/api/chains/nope")).status).toBe(404);
    });

    it("lists finished chains newest first, a page at a time", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const first = await finished(ann, ben, cat, "First");
      await M.Chain.updateOne({ _id: first }, { $set: { completedAt: new Date(Date.now() - 60_000) } });
      await M.RateLimitHit.deleteMany({});
      const second = await finished(ann, ben, cat, "Second");
      const list = (await ann.agent.get("/api/chains/complete")).body;
      expect(list.chains.map((c) => c.id)).toEqual([second, first]);
      expect(list.chains[0].sections).toHaveLength(3);
      expect(list.hasMore).toBe(false);
    });

    it("lists the chains you drew a part of, finished or not, and which one you may take back", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const waitingId = await begin(ann, "Waiting");
      await M.RateLimitHit.deleteMany({});
      const doneId = await finished(ann, ben, cat, "Done");
      const mine = (await ann.agent.get("/api/chains/mine")).body.chains;
      expect(mine.map((c) => [c.id, c.complete, c.canDelete]).sort()).toEqual([[waitingId, false, true], [doneId, true, false]].sort());
      expect((await ben.agent.get("/api/chains/mine")).body.chains.map((c) => c.id)).toEqual([doneId]);
      expect((await (await signup(app, "dee")).agent.get("/api/chains/mine")).body.chains).toEqual([]);
    });

    it("hides a chain from someone who has blocked one of its artists, or when one of them goes private or is suspended", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const dee = await signup(app, "dee");
      const id = await finished(ann, ben, cat);
      expect((await dee.agent.get("/api/chains/complete")).body.chains).toHaveLength(1);
      await M.User.updateOne({ _id: ben.user.id }, { $set: { isPrivate: true } });
      expect((await dee.agent.get("/api/chains/complete")).body.chains).toHaveLength(0);
      expect((await dee.agent.get(`/api/chains/${id}`)).status).toBe(404);
      expect((await dee.agent.get(`/api/chains/${id}/sections/0/image`)).status).toBe(404);
      await M.User.updateOne({ _id: ben.user.id }, { $set: { isPrivate: false } });
      await dee.agent.post("/api/users/cat/block");
      expect((await dee.agent.get("/api/chains/complete")).body.chains).toHaveLength(0);
      await dee.agent.delete("/api/users/cat/block");
      await M.User.updateOne({ _id: ann.user.id }, { $set: { suspendedAt: new Date() } });
      expect((await dee.agent.get("/api/chains/complete")).body.chains).toHaveLength(0);
    });
  });

  describe("the pictures", () => {
    const bytes = (r) => r.buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    it("gives a finished chain's parts to anyone who may see it, exactly as drawn", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const dee = await signup(app, "dee");
      const id = await finished(ann, ben, cat);
      const res = await bytes(dee.agent.get(`/api/chains/${id}/sections/1/image`));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.body.equals(section(2))).toBe(true);
      expect((await dee.agent.get(`/api/chains/${id}/sections/3/image`)).status).toBe(404);
      expect((await dee.agent.get(`/api/chains/${id}/sections/x/image`)).status).toBe(404);
    });

    it("keeps the parts of a chain that isn't finished from everyone but the artist and a moderator", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const boss = await signup(app, "boss");
      await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
      const id = await begin(ann);
      expect((await ann.agent.get(`/api/chains/${id}/sections/0/image`)).status).toBe(200);
      expect((await ben.agent.get(`/api/chains/${id}/sections/0/image`)).status).toBe(404);
      expect((await boss.agent.get(`/api/chains/${id}/sections/0/image`)).status).toBe(200);
    });
  });

  describe("taking a chain back", () => {
    it("is for the person who started it, while it is not finished, and takes its parts with it", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const id = await begin(ann);
      await claim(ben, id);
      await add(ben, id);
      expect((await ben.agent.delete(`/api/chains/${id}`)).status).toBe(404);
      expect((await ann.agent.delete(`/api/chains/${id}`)).status).toBe(204);
      expect(await M.Chain.countDocuments()).toBe(0);
      expect(await M.ChainSection.countDocuments()).toBe(0);
      await M.RateLimitHit.deleteMany({});
      const done = await finished(ann, ben, cat);
      const res = await ann.agent.delete(`/api/chains/${done}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("belongs to everyone");
    });
  });

  describe("reports and moderation", () => {
    const report = (who, id) => who.agent.post("/api/reports").send({ targetType: "chainSection", targetId: id, reason: "Not suitable" });

    it("lets anyone report a part of a finished chain, and only the person about to continue a chain that isn't", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const dee = await signup(app, "dee");
      const waitingId = await begin(dee, "Waiting");
      const part0 = (await M.ChainSection.findOne({ chain: waitingId, index: 0 }))._id;
      expect((await report(ann, part0)).status).toBe(404);
      await claim(ann, waitingId);
      expect((await report(ann, part0)).status).toBe(201);
      expect((await report(ben, part0)).status).toBe(404);
      const id = await finished(ann, ben, cat, "Done");
      const part1 = (await M.ChainSection.findOne({ chain: id, index: 1 }))._id;
      expect((await report(dee, part1)).status).toBe(201);
      expect((await report(dee, "64b64b64b64b64b64b64b64b")).status).toBe(404);
    });

    it("shows a moderator the picture and where it is, and removing it removes the whole chain and tells the artist", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const dee = await signup(app, "dee");
      const boss = await signup(app, "boss");
      await M.User.updateOne({ _id: boss.user.id }, { $set: { emailVerified: true } });
      const id = await finished(ann, ben, cat, "Done");
      const part1 = (await M.ChainSection.findOne({ chain: id, index: 1 }))._id;
      await report(dee, part1);
      const cases = (await boss.agent.get("/api/admin/reports")).body.cases;
      const found = cases.find((c) => c.targetType === "chainSection");
      expect(found.target).toMatchObject({ image: `/api/chains/${id}/sections/1/image`, link: `/chains/${id}`, title: "Done" });
      expect(found.target.author.username).toBe("ben");
      const done = await boss.agent.post("/api/admin/reports/resolve").send({ targetType: "chainSection", targetId: String(part1), action: "remove" });
      expect(done.body.removed).toBe(true);
      expect(await M.Chain.countDocuments()).toBe(0);
      expect(await M.ChainSection.countDocuments()).toBe(0);
      expect(await M.Notification.countDocuments({ type: "chain_done" })).toBe(0);
      expect(await M.Notification.countDocuments({ recipient: ben.user.id, type: "content_removed" })).toBe(1);
    });
  });

  describe("accounts", () => {
    it("takes with a deleted account every chain it drew a part of, and lets go of a part it was about to draw", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      const waitingId = await begin(cat, "Waiting");
      await claim(ben, waitingId);
      const id = await finished(ann, ben, cat, "Done");
      const res = await ben.agent.delete("/api/profiles/me").send({ password: "Passw0rd!x" });
      expect(res.status).toBe(204);
      expect(await M.Chain.findById(id)).toBeNull();
      expect(await M.ChainSection.countDocuments({ chain: id })).toBe(0);
      const waiting = await M.Chain.findById(waitingId);
      expect(waiting.claimUser).toBeNull();
      expect(waiting.count).toBe(1);
    });

    it("includes the parts a person drew in their data download", async () => {
      const ann = await signup(app, "ann");
      const ben = await signup(app, "ben");
      const cat = await signup(app, "cat");
      await finished(ann, ben, cat, "Done");
      const data = (await ben.agent.post("/api/profiles/me/export").send({ password: "Passw0rd!x" })).body;
      expect(data.portfolio.chainParts).toHaveLength(1);
      expect(data.portfolio.chainParts[0]).toMatchObject({ idea: "Done", part: 2, finished: true });
      expect(JSON.stringify(data)).not.toContain("png");
    });
  });
});
