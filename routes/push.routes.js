import { Router } from "express";
import { PushSubscription } from "../models/PushSubscription.js";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter } from "../utils/rateLimit.js";
import { CATEGORY_NAMES, checkPrefs, checkSubscription } from "../utils/pushInput.js";
import { pushPublicKey, sendTestPush } from "../services/push.js";

// Push notifications: which of a person's devices get them, and which kinds. The sending itself is in services/push.js.
export const pushRouter = Router();
pushRouter.use(requireAuth);

const MAX_DEVICES = 10;
const subscribeLimiter = createLimiter({ name: "push-subscribe", limit: 20, windowMs: 60 * 60 * 1000 });
const testLimiter = createLimiter({ name: "push-test", limit: 5, windowMs: 60 * 60 * 1000 });

const unavailable = (res) => res.status(503).json({ error: "Push notifications aren't available on this site yet" });
const prefsOf = (user) => Object.fromEntries(CATEGORY_NAMES.map((name) => [name, user?.pushPrefs?.[name] !== false]));

// Whether this site can send them, and the public key a device needs to sign up.
pushRouter.get("/key", (req, res) => {
  const publicKey = pushPublicKey();
  res.json({ enabled: Boolean(publicKey), publicKey });
});

// Where you stand: how many devices, whether the asking one (by its address) is one of them, and the switches.
pushRouter.get("/status", async (req, res) => {
  const endpoint = typeof req.query.endpoint === "string" ? req.query.endpoint : "";
  const [devices, mine, user] = await Promise.all([
    PushSubscription.countDocuments({ user: req.user.id }),
    endpoint ? PushSubscription.exists({ user: req.user.id, endpoint }) : null,
    User.findById(req.user.id).select("pushPrefs"),
  ]);
  res.json({ enabled: Boolean(pushPublicKey()), devices, thisDevice: Boolean(mine), prefs: prefsOf(user) });
});

// Turn notifications on for a device. A device belongs to whoever signed in on it last (so two people sharing a browser never get each
// other's), and a person keeps at most ten: the oldest goes when they add an eleventh.
pushRouter.post("/subscribe", async (req, res) => {
  if (!pushPublicKey()) return unavailable(res);
  const checked = checkSubscription(req.body?.subscription);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!(await subscribeLimiter.allow(req.user.id))) return res.status(429).json({ error: "You've turned notifications on a lot of times just now — try again later" });

  const { endpoint, p256dh, auth } = checked.value;
  const already = await PushSubscription.exists({ user: req.user.id, endpoint });
  if (!already) {
    const mineNow = await PushSubscription.find({ user: req.user.id }).sort({ createdAt: 1 }).select("_id");
    if (mineNow.length >= MAX_DEVICES) await PushSubscription.deleteMany({ _id: { $in: mineNow.slice(0, mineNow.length - MAX_DEVICES + 1).map((s) => s._id) } });
  }
  await PushSubscription.findOneAndUpdate({ endpoint }, { $set: { user: req.user.id, p256dh, auth, userAgent: String(req.get("user-agent") ?? "").slice(0, 200) } }, { upsert: true });
  res.status(201).json({ subscribed: true });
});

// Turn them off for a device (also done when someone logs out). Saying it twice is fine.
pushRouter.post("/unsubscribe", async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 700) return res.status(400).json({ error: "Say which device" });
  await PushSubscription.deleteOne({ endpoint, user: req.user.id });
  res.status(204).end();
});

// Which kinds you want; the ones you don't mention stay as they are.
pushRouter.patch("/preferences", async (req, res) => {
  const checked = checkPrefs(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const set = Object.fromEntries(Object.entries(checked.value).map(([name, on]) => [`pushPrefs.${name}`, on]));
  const user = await User.findByIdAndUpdate(req.user.id, { $set: set }, { returnDocument: "after" }).select("pushPrefs");
  res.json({ prefs: prefsOf(user) });
});

// A test message to your own devices, so you can see it working.
pushRouter.post("/test", async (req, res) => {
  if (!pushPublicKey()) return unavailable(res);
  if (!(await PushSubscription.exists({ user: req.user.id }))) return res.status(400).json({ error: "Turn on notifications on this device first" });
  if (!(await testLimiter.allow(req.user.id))) return res.status(429).json({ error: "That's enough tests for now — try again later" });
  res.json({ sent: await sendTestPush(req.user.id) });
});
