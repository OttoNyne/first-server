import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A software passkey, for tests: what a phone or a password manager does, minus the screen. It makes real key pairs and signs with them,
// so the server's checks (the challenge, the origin, the domain, the counter, the signature) are exercised for real.

// Just enough CBOR for an attestation: unsigned and negative integers, byte strings, text, and maps.
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    throw new Error("too big for this encoder");
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error("unsupported value");
}

const sha256 = (data) => createHash("sha256").update(data).digest();
const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

export class SoftAuthenticator {
  /**
   * @param rpId       the domain this authenticator will answer for
   * @param origin     the address it says the page was at
   * @param userVerified  whether it checked the person (fingerprint, face, PIN)
   */
  constructor({ rpId, origin, userVerified = true, synced = false } = {}) {
    this.rpId = rpId;
    this.origin = origin;
    this.userVerified = userVerified;
    this.synced = synced;
    this.credentials = new Map(); // id -> { privateKey, counter, userHandle }
  }

  #flags(extra = 0) {
    return FLAGS.UP | (this.userVerified ? FLAGS.UV : 0) | (this.synced ? FLAGS.BE | FLAGS.BS : 0) | extra;
  }

  #authData(counter, extraFlags = 0, attested = null) {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const parts = [sha256(this.rpId), Buffer.from([this.#flags(extraFlags)]), counterBytes];
    if (attested) parts.push(attested);
    return Buffer.concat(parts);
  }

  /** Answers navigator.credentials.create(). `options` is what the server sent. Returns what the browser would send back. */
  create(options, { origin = this.origin, challenge = options.challenge, rpId = this.rpId } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = randomBytes(32);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, credentialId, cose]);
    const saved = this.rpId;
    this.rpId = rpId;
    const authData = this.#authData(0, FLAGS.AT, attested);
    this.rpId = saved;
    this.credentials.set(b64(credentialId), { privateKey, counter: 0, userHandle: options.user.id });
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false });
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64(credentialId),
      rawId: b64(credentialId),
      type: "public-key",
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answers navigator.credentials.get(). With no id given it uses the only (or the newest) passkey it holds, as a phone offers one. */
  get(options, { id = [...this.credentials.keys()].at(-1), origin = this.origin, challenge = options.challenge, rpId = this.rpId, counter, userHandle } = {}) {
    const credential = this.credentials.get(id);
    if (!credential) throw new Error("This authenticator has no such passkey");
    credential.counter = counter ?? credential.counter + 1;
    const saved = this.rpId;
    this.rpId = rpId;
    const authData = this.#authData(credential.counter);
    this.rpId = saved;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), credential.privateKey);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature), userHandle: userHandle ?? credential.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
