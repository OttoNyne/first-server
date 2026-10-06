import mongoose from "mongoose";

// One signed-in browser or phone. The sign-in cookie carries this row's id, so a session can be looked at and ended
// from the person's own list of devices; once the row is gone that cookie no longer works. It holds only what the owner
// sees (a plain "Chrome on Windows" label and when it was started and last used), never an address or the browser's full text.
// The row goes by itself after seven days, when the cookie would have expired anyway.
const sessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  device: { type: String, default: "A browser", maxlength: 80 },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  expireAt: { type: Date, required: true },
});

sessionSchema.index({ user: 1, lastSeenAt: -1 });
sessionSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);
