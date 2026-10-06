import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { passwordVersion } from "../middleware/auth.js";
import { open } from "../utils/secretBox.js";
import { hashRecoveryCode, looksLikeRecoveryCode, matchStep } from "../utils/totp.js";

const CHALLENGE_MINUTES = 5;

/** What login hands back after a right password when a second step is needed: not a sign-in (it has no id and the sign-in check refuses anything with a purpose), and no use without a code. */
export function signChallenge(user) {
  return jwt.sign({ purpose: "two-step", uid: user._id.toString(), pv: passwordVersion(user) }, process.env.JWT_SECRET, { expiresIn: `${CHALLENGE_MINUTES}m` });
}

/** The user it was issued for, or null if it is forged, old, for something else, or the password has changed since. */
export async function userForChallenge(token) {
  let payload;
  try {
    payload = jwt.verify(typeof token === "string" ? token : "", process.env.JWT_SECRET);
  } catch {
    return null;
  }
  if (payload.purpose !== "two-step") return null;
  const user = await User.findById(payload.uid);
  if (!user || user.suspendedAt || !user.twoFactor?.enabled || payload.pv !== passwordVersion(user)) return null;
  return user;
}

/**
 * Is this the right second step for this person: the code their app shows, or one of their recovery codes? Either is used up by being
 * used: an app code can't be used again (nor an earlier one), and a recovery code is removed. Both are claimed in one database step,
 * so two requests carrying the same code can't both succeed. Returns "app", "recovery" or null.
 */
export async function checkSecondStep(user, input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text || text.length > 40) return null;

  const digits = text.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    if (!user.twoFactor?.secret) return null;
    let step;
    try {
      step = matchStep(open(user.twoFactor.secret), digits);
    } catch {
      return null;
    }
    if (step === null) return null;
    const claimed = await User.updateOne({ _id: user._id, "twoFactor.lastStep": { $lt: step } }, { $set: { "twoFactor.lastStep": step } });
    return claimed.modifiedCount === 1 ? "app" : null;
  }

  if (looksLikeRecoveryCode(text)) {
    const hash = hashRecoveryCode(text);
    const claimed = await User.updateOne({ _id: user._id, "twoFactor.recoveryHashes": hash }, { $pull: { "twoFactor.recoveryHashes": hash } });
    return claimed.modifiedCount === 1 ? "recovery" : null;
  }
  return null;
}
