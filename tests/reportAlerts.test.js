import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { connectTestDb, clearTestDb, disconnectTestDb } from "./helpers/testDb.js";

const outbox = [];
vi.mock("../utils/mailer.js", () => ({
  mailAvailable: () => true,
  sendMail: vi.fn(async (mail) => {
    outbox.push(mail);
    return { sent: true };
  }),
}));

let signups = 0;
async function signup(app, name, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/register").set("x-vercel-forwarded-for", `198.51.131.${++signups}`).send({ email: `${name}@example.com`, username: name, password: "password123", displayName: name, ...extra });
  return { agent, user: res.body.user };
}

const MINUTE = 60 * 1000;

describe("telling the moderators about new reports", () => {
  let app, M, alerts;
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = "boss@example.com,second@example.com,unverified@example.com,suspended@example.com";
    process.env.CLIENT_URL = "https://www.example.com";
    await connectTestDb();
    ({ app } = await import("../app.js"));
    alerts = await import("../services/reportAlerts.js");
    M = {
      User: (await import("../models/User.js")).User,
      Report: (await import("../models/Report.js")).Report,
    };
  });
  beforeEach(async () => {
    await clearTestDb();
    outbox.length = 0;
    delete process.env.REPORT_ALERTS;
  });
  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    delete process.env.CLIENT_URL;
    delete process.env.REPORT_ALERTS;
    await clearTestDb();
    await disconnectTestDb();
  });

  /** The moderators: two confirmed, one not confirmed, one suspended; plus an ordinary member who files reports about a post. */
  async function world() {
    const boss = await signup(app, "boss");
    const second = await signup(app, "second", { displayName: "Segundo" });
    const unverified = await signup(app, "unverified");
    const suspended = await signup(app, "suspended");
    await M.User.updateMany({ _id: { $in: [boss.user.id, second.user.id, suspended.user.id] } }, { $set: { emailVerified: true } });
    await M.User.updateOne({ _id: suspended.user.id }, { $set: { suspendedAt: new Date() } });
    await M.User.updateOne({ _id: second.user.id }, { $set: { language: "es" } });
    const author = await signup(app, "author");
    const reporter = await signup(app, "reporter");
    const reporter2 = await signup(app, "reporter2");
    outbox.length = 0; // the sign-up emails aren't what is being looked at
    const post = async (content = "A post") => (await author.agent.post("/api/posts").send({ content })).body.post;
    const report = async (who, targetId, reason = "Spam") => who.agent.post("/api/reports").send({ targetType: "post", targetId, reason });
    return { boss, second, unverified, suspended, author, reporter, reporter2, post, report };
  }

  it("emails the confirmed, active moderators when a report is filed, and nobody else", async () => {
    const w = await world();
    const p = await w.post();
    expect((await w.report(w.reporter, p.id)).status).toBe(201);
    await alerts.settleReportAlerts();
    expect(outbox.map((m) => m.to).sort()).toEqual(["boss@example.com", "second@example.com"]);
    const english = outbox.find((m) => m.to === "boss@example.com");
    expect(english.subject).toBe("CreativesSelect: 1 new report to review");
    expect(english.text).toContain("https://www.example.com/admin/moderation");
    expect(english.text).toContain("1 open in total");
    // in each moderator's own language
    expect(outbox.find((m) => m.to === "second@example.com").subject).toBe("CreativesSelect: 1 denuncia nueva por revisar");
    expect(outbox.find((m) => m.to === "second@example.com").text).toContain("Segundo");
  });

  it("never puts what was reported, the reason or who reported it in the email", async () => {
    const w = await world();
    const p = await w.post("SECRET_POST_WORDS about a thing");
    await w.report(w.reporter, p.id, "REASON_WORDS click http://evil.example/phish now");
    await alerts.settleReportAlerts();
    expect(outbox.length).toBe(2);
    for (const mail of outbox) {
      const all = `${mail.subject}\n${mail.text}`;
      expect(all).not.toMatch(/SECRET_POST_WORDS|REASON_WORDS|evil\.example|reporter|author/i);
      expect(all).not.toContain(p.id);
    }
  });

  it("sends one email for a burst of reports, then one more for the ones that waited once the quiet five minutes are over", async () => {
    const w = await world();
    const first = await w.post("one");
    const second = await w.post("two");
    const third = await w.post("three");
    await w.report(w.reporter, first.id);
    await alerts.settleReportAlerts();
    expect(outbox.length).toBe(2); // the first goes at once
    await w.report(w.reporter, second.id);
    await w.report(w.reporter2, third.id);
    await alerts.settleReportAlerts();
    expect(outbox.length).toBe(2); // in the quiet time: nothing more
    expect(await M.Report.countDocuments({ alertedAt: null })).toBe(2);
    // two minutes later is still quiet, six minutes later is not
    expect((await alerts.alertAdminsOfReports({ at: new Date(Date.now() + 2 * MINUTE) })).sent).toBe(0);
    const later = await alerts.alertAdminsOfReports({ at: new Date(Date.now() + 6 * MINUTE) });
    expect(later).toEqual({ sent: 2, reports: 2 });
    expect(outbox.length).toBe(4);
    expect(outbox[2].subject).toBe("CreativesSelect: 2 new reports to review");
    expect(outbox[2].text).toContain("3 open in total");
    // and nothing is said twice
    expect((await alerts.alertAdminsOfReports({ at: new Date(Date.now() + 20 * MINUTE) })).sent).toBe(0);
    expect(outbox.length).toBe(4);
  });

  it("sends once when two runs happen at the same moment", async () => {
    const w = await world();
    const p = await w.post();
    await M.Report.create({ reporter: w.reporter.user.id, targetType: "post", targetId: p.id, reason: "Spam" });
    const at = new Date(Date.now() + MINUTE);
    const [a, b] = await Promise.all([alerts.alertAdminsOfReports({ at }), alerts.alertAdminsOfReports({ at })]);
    expect(a.reports + b.reports).toBe(1);
    expect(outbox.length).toBe(2);
  });

  it("doesn't count reports a moderator already dealt with, or ones older than a day", async () => {
    const w = await world();
    const p = await w.post();
    const handled = await M.Report.create({ reporter: w.reporter.user.id, targetType: "post", targetId: p.id, reason: "Spam" });
    await M.Report.updateOne({ _id: handled._id }, { $set: { status: "dismissed" } });
    // an old report from before the alerts existed: inserted straight into the database with a date two days ago
    await M.Report.collection.insertOne({ reporter: w.reporter2.user.id, targetType: "post", targetId: new (await import("mongoose")).default.Types.ObjectId(p.id), reason: "Old", status: "open", alertedAt: null, createdAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE), updatedAt: new Date() });
    expect(await alerts.alertAdminsOfReports({ at: new Date(Date.now() + MINUTE) })).toEqual({ sent: 0, reports: 0 });
    expect(outbox.length).toBe(0);
  });

  it("waits, with the report still unalerted, when no moderator can be told yet, and tells them once one can be", async () => {
    const w = await world();
    await M.User.updateMany({ email: { $in: ["boss@example.com", "second@example.com"] } }, { $set: { emailVerified: false } });
    const p = await w.post();
    await w.report(w.reporter, p.id);
    await alerts.settleReportAlerts();
    expect(outbox.length).toBe(0);
    expect(await M.Report.countDocuments({ alertedAt: null })).toBe(1);
    await M.User.updateOne({ email: "boss@example.com" }, { $set: { emailVerified: true } });
    expect(await alerts.alertAdminsOfReports({ at: new Date(Date.now() + MINUTE) })).toEqual({ sent: 1, reports: 1 });
    expect(outbox.map((m) => m.to)).toEqual(["boss@example.com"]);
  });

  it("can be switched off, and doesn't slow or break filing a report", async () => {
    const w = await world();
    process.env.REPORT_ALERTS = "off";
    const p = await w.post();
    const res = await w.report(w.reporter, p.id);
    await alerts.settleReportAlerts();
    expect(res.status).toBe(201);
    expect(outbox.length).toBe(0);
    expect(await M.Report.countDocuments({ alertedAt: null })).toBe(1);
  });

  it("is not triggered by a duplicate report, or one for something that doesn't exist", async () => {
    const w = await world();
    const p = await w.post();
    await w.report(w.reporter, p.id);
    await alerts.settleReportAlerts();
    const before = outbox.length;
    expect((await w.report(w.reporter, p.id)).body.duplicate).toBe(true);
    expect((await w.report(w.reporter2, "6ac93c2f67d5dc8c7fdb7931")).status).toBe(404);
    await alerts.settleReportAlerts();
    expect(outbox.length).toBe(before);
    expect(await M.Report.countDocuments()).toBe(1);
  });
});
