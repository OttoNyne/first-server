import { sessionIsStillValid } from "../middleware/auth.js";

// Live updates: a long-lived connection from each open page (server-sent events), down which the server says "something new" the moment
// it happens, so the bell and the message badge change at once instead of at the next poll.
//
// What goes down it is only a HINT with nothing private in it ("a notification", "a message in your chat with sam"). The page then asks the
// ordinary, checked endpoints for the real thing, so this adds no new way to read anything. If the connection can't be made or breaks
// (a proxy that holds data back, the server restarting, a second server instance that didn't see the event), the page's own polling carries on
// at a slower pace, so the worst case is the old behaviour.
//
// It keeps connections in this process's memory, which fits one server. The sign-in each connection was opened with is checked again every
// minute, so signing a device out from the list closes its stream.
export const LIMITS = { heartbeatMs: 20_000, recheckEveryBeats: 3, maxAgeMs: 5 * 60_000, maxPerPerson: 5, maxTotal: 1000 };

const open = new Map(); // person id -> Set of connections
let total = 0;
let timer = null;

const send = (conn, text) => {
  try {
    conn.res.write(text);
    return true;
  } catch {
    return false;
  }
};

function closeConnection(conn) {
  const set = open.get(conn.user);
  if (!set?.delete(conn)) return;
  if (set.size === 0) open.delete(conn.user);
  total -= 1;
  try {
    conn.res.end();
  } catch {
    // already gone
  }
  if (total === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function beat() {
  const now = Date.now();
  for (const set of [...open.values()]) {
    for (const conn of [...set]) {
      conn.beats += 1;
      if (now - conn.since > LIMITS.maxAgeMs) {
        // The page reconnects by itself; ending the old one now keeps every connection short-lived.
        send(conn, "event: reconnect\ndata: {}\n\n");
        closeConnection(conn);
      } else if (!send(conn, ": keep-alive\n\n")) {
        closeConnection(conn);
      } else if (conn.beats % LIMITS.recheckEveryBeats === 0 && !(await sessionIsStillValid(conn.token))) {
        send(conn, "event: signed-out\ndata: {}\n\n");
        closeConnection(conn);
      }
    }
  }
}

/** Starts a stream for this signed-in person on this request. Returns false (having answered) if there are too many. */
export function openStream(req, res, { userId, token }) {
  const mine = open.get(userId) ?? new Set();
  if (total >= LIMITS.maxTotal) {
    res.status(503).set("Retry-After", "30").json({ error: "Live updates are busy right now. The page will keep checking on its own." });
    return false;
  }
  // A person with many tabs open gets the newest few; the oldest simply reconnects or falls back to polling.
  while (mine.size >= LIMITS.maxPerPerson) closeConnection(mine.values().next().value);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // a proxy must pass each event on as it is written
  });
  const conn = { user: String(userId), res, token, since: Date.now(), beats: 0 };
  const set = open.get(conn.user) ?? new Set();
  set.add(conn);
  open.set(conn.user, set);
  total += 1;
  res.write("retry: 5000\n: connected\n\n");
  req.on("close", () => closeConnection(conn));
  if (!timer) {
    timer = setInterval(() => void beat(), LIMITS.heartbeatMs);
    timer.unref();
  }
  return true;
}

/** Tells every open page of this person that something happened. Never throws, and does nothing if they have no page open. */
export function publish(userId, type, data = {}) {
  try {
    const set = open.get(String(userId));
    if (!set) return 0;
    const text = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    let sent = 0;
    for (const conn of [...set]) {
      if (send(conn, text)) sent += 1;
      else closeConnection(conn);
    }
    return sent;
  } catch {
    return 0;
  }
}

/** A message was sent, changed or removed: both people are told, each with who it was with, so an open chat knows whether it is theirs. */
export function tellBoth(senderName, recipientName, senderId, recipientId) {
  publish(recipientId, "message", { with: senderName });
  publish(senderId, "message", { with: recipientName });
}

export const connectionCount = () => total;

/** For tests: close everything and stop the timer. */
export function closeAll() {
  for (const set of [...open.values()]) for (const conn of [...set]) closeConnection(conn);
}
