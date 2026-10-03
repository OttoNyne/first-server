import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";

// Voice lives of up to 100 listeners go through a LiveKit media server (an "SFU"): the host sends their
// audio once and the server fans it out. The audio never touches this API. We only create the room, hand
// each person a short-lived token saying what they may do in it, and remove people/rooms when needed.
//
//   LIVEKIT_URL          the project's address, e.g. wss://your-project.livekit.cloud
//   LIVEKIT_API_KEY      }
//   LIVEKIT_API_SECRET   } created in the LiveKit Cloud project's settings
//   LIVE_MAX_LISTENERS   optional: 50 (the default) to 100
//
// Without those three the site falls back to browser-to-browser audio, which only carries a few listeners.
export const sfuConfigured = () => Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

export const MESH_MAX_LISTENERS = 8;
// How many listeners the host can have on the stage (speaking) at once.
export const MAX_STAGE_GUESTS = 9;
export const SFU_MIN_LISTENERS = 50;
export const SFU_MAX_LISTENERS = 100;

export function sfuMaxListeners() {
  const n = Number.parseInt(process.env.LIVE_MAX_LISTENERS ?? "", 10);
  if (!Number.isFinite(n)) return SFU_MIN_LISTENERS;
  return Math.min(SFU_MAX_LISTENERS, Math.max(SFU_MIN_LISTENERS, n));
}

// The management API is plain HTTPS on the same host the browsers reach over wss://.
const httpUrl = () => process.env.LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const roomService = () => new RoomServiceClient(httpUrl(), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);

export async function createSfuRoom(name, maxListeners) {
  // +1 for the host
  await roomService().createRoom({ name, maxParticipants: maxListeners + 1, emptyTimeout: 120 });
}

// Closing a room disconnects everyone in it. Best effort: the live is over either way.
export async function deleteSfuRoom(name) {
  try {
    await roomService().deleteRoom(name);
  } catch (err) {
    console.error(`Couldn't close media room ${name}:`, err.message);
  }
}

export async function removeSfuParticipant(room, identity) {
  try {
    await roomService().removeParticipant(room, String(identity));
  } catch (err) {
    // they may simply not be connected (yet)
    if (!/not found|does not exist/i.test(err?.message ?? "")) console.error("Couldn't remove a participant:", err.message);
  }
}

// Lets a listener who is already in the room speak (or stops them), without reconnecting. They may only ever publish a
// microphone. Throws if the media server can't be reached or the person isn't connected to the room.
export async function setSfuPublishing(room, identity, canPublish) {
  await roomService().updateParticipant(room, String(identity), {
    // permissions are replaced as a whole, so everything is spelled out
    permission: { canSubscribe: true, canPublish, canPublishData: false, canPublishSources: canPublish ? [TrackSource.MICROPHONE] : [] },
  });
}

// A one-hour pass for one person in one room. The host may publish a microphone; everyone else may only
// listen, unless the host has brought them on stage. (Chat doesn't go through the media server, so nobody can send data in it.)
export async function sfuToken({ room, identity, name, canPublish }) {
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: String(identity),
    name,
    ttl: "1h",
  });
  token.addGrant({
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: Boolean(canPublish),
    canPublishData: false,
    ...(canPublish ? { canPublishSources: [TrackSource.MICROPHONE] } : {}),
  });
  return token.toJwt();
}
