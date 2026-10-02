import mongoose from "mongoose";

// One outstanding "reset my password" link per user. Only a SHA-256 hash of the
// token is stored, so reading the database never yields a usable link; the
// TTL index deletes expired rows on its own.
const passwordResetSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  tokenHash: { type: String, required: true, unique: true },
  expireAt: { type: Date, required: true, expires: 0 },
});
passwordResetSchema.index({ user: 1 });

export const PasswordReset = mongoose.model("PasswordReset", passwordResetSchema);
