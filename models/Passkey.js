import mongoose from "mongoose";

// A passkey: a key pair kept by the person's phone, computer or password manager, of which the site holds only the PUBLIC half. Signing in
// with it needs the device (and the person's fingerprint, face or PIN), and the browser will only use it on this site's own address, so it
// can't be handed over to a fake login page. See routes/passkeys.routes.js.
const passkeySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // What the device calls this key (base64url). Unique across the site.
    credentialId: { type: String, required: true, unique: true, maxlength: 1400 },
    // The public key, as the device gave it (COSE, base64url). Useless without the device that holds the private half.
    publicKey: { type: String, required: true, maxlength: 2000 },
    // How many times the device says it has signed: it must only go up, which is how a cloned key is noticed.
    counter: { type: Number, default: 0 },
    transports: { type: [String], default: [] },
    // The owner's own label for it ("iPhone", "Work laptop").
    name: { type: String, required: true, maxlength: 40 },
    // Whether it is kept in only one place or copied between a person's devices, and whether that copy is backed up.
    deviceType: { type: String, enum: ["singleDevice", "multiDevice"], default: "singleDevice" },
    backedUp: { type: Boolean, default: false },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

passkeySchema.index({ user: 1, createdAt: 1 });

export const Passkey = mongoose.model("Passkey", passkeySchema);
