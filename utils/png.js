// A drawing sent by the sketchpad is a PNG of one exact size. It is stored and given out as it came, never decoded here, so what is checked is
// what can be checked without decoding: that it starts like a PNG, says it is the size the page makes, and is not larger than a drawing needs.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The width and height a PNG says it has (from its first chunk), or null if it doesn't start like a PNG. */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  // the first chunk is always IHDR: length (4 bytes, 13), the name, then width and height
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** `{ ok: true }` or `{ error }` for a picture that must be exactly `width` × `height` and at most `maxBytes` long. */
export function checkPng(buffer, { width, height, maxBytes }) {
  const size = pngSize(buffer);
  if (!size) return { error: "That isn't a PNG picture" };
  if (buffer.length > maxBytes) return { error: "That drawing is too large", status: 413 };
  if (size.width !== width || size.height !== height) return { error: "That drawing isn't the right size" };
  return { ok: true };
}
