import mongoose from "mongoose";

// One outstanding "confirm your email" link per user. Only a SHA-256 hash of the token is stored, so reading
// the database never yields a usable link; the TTL index deletes expired rows on its own.
const emailVerificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  tokenHash: { type: String, required: true, unique: true },
  expireAt: { type: Date, required: true, expires: 0 },
});
emailVerificationSchema.index({ user: 1 });

export const EmailVerification = mongoose.model("EmailVerification", emailVerificationSchema);
