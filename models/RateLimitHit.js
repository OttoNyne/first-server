import mongoose from "mongoose";

// One document per rate-limited action. Stored in MongoDB rather than in
// process memory so limits survive a restart and are shared by every server
// instance; the TTL index lets MongoDB delete expired hits on its own.
const rateLimitHitSchema = new mongoose.Schema({
  key: { type: String, required: true },
  at: { type: Date, required: true },
  expireAt: { type: Date, required: true, expires: 0 },
});
rateLimitHitSchema.index({ key: 1, at: -1 });

export const RateLimitHit = mongoose.model("RateLimitHit", rateLimitHitSchema);
