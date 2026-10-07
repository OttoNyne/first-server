import mongoose from "mongoose";

// The random value a passkey signs, kept for a few minutes and used once. Registering is tied to the signed-in person who asked for it;
// signing in is not tied to anyone (the person isn't known until the key answers). The TTL index removes forgotten ones.
const passkeyChallengeSchema = new mongoose.Schema({
  challenge: { type: String, required: true, unique: true },
  purpose: { type: String, enum: ["register", "login"], required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  expireAt: { type: Date, required: true, expires: 0 },
});

export const PasskeyChallenge = mongoose.model("PasskeyChallenge", passkeyChallengeSchema);
