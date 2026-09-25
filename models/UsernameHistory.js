import mongoose from "mongoose";

// A username someone just gave up. It stays reserved for its previous owner
// for 30 days (then MongoDB's TTL index deletes the row), so a changed name
// can't be instantly grabbed by someone else to impersonate the old account
// or hijack links that point at it.
const usernameHistorySchema = new mongoose.Schema({
  username: { type: String, required: true, lowercase: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  expireAt: { type: Date, required: true, expires: 0 },
});

export const UsernameHistory = mongoose.model("UsernameHistory", usernameHistorySchema);
