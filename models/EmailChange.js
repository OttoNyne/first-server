import mongoose from "mongoose";

// A change of the account's email address, in two stages, each with its own one-time link (only a SHA-256 hash of it is stored):
//   pending      the link was sent to the NEW address; opening it proves the person controls that address, and only then does the
//                account's email change. Expires after an hour. One per person (a new request replaces it).
//   revertible   it has changed. The link was sent to the OLD address, so someone who got into the account and moved the email can be
//                undone by the real owner for a week. Expires after seven days.
// The TTL index removes expired rows on its own.
const emailChangeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: ["pending", "revertible"], required: true },
  oldEmail: { type: String, required: true },
  newEmail: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true },
  expireAt: { type: Date, required: true, expires: 0 },
});
emailChangeSchema.index({ user: 1, kind: 1 });

export const EmailChange = mongoose.model("EmailChange", emailChangeSchema);
