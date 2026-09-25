// Portfolio videos are limited to 30 seconds. Uploads are measured by the
// storage provider; links can't be measured (we never download them), so a
// linked video is *played* as a 30-second window: a YouTube embed gets
// `start`/`end` parameters, a direct file is paused at start + 30 s.
export const MAX_VIDEO_SECONDS = 30;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const DIRECT_VIDEO = /\.(mp4|webm|mov|m4v)$/i;

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// Turns whatever the user pasted into { type, url } or throws a 400-style error.
//   YouTube link      -> { type: "embed", url: "https://www.youtube.com/watch?v=ID" }
//   direct video link -> { type: "video", url: "https://…/clip.mp4" }
// Only https links, and only these two shapes: nothing else is ever stored as a
// video, so the URL is always safe to put in an <iframe>/<video> src.
export function parseVideoLink(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2000) fail("Enter a video link");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    fail("That doesn't look like a link");
  }
  if (url.protocol !== "https:") fail("Video links must start with https://");

  if (YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    let id = null;
    if (url.hostname.toLowerCase().endsWith("youtu.be")) {
      id = url.pathname.split("/")[1];
    } else if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      const m = url.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
      id = m?.[1];
    }
    if (!id || !YOUTUBE_ID.test(id)) fail("That YouTube link doesn't include a video");
    return { type: "embed", url: `https://www.youtube.com/watch?v=${id}` };
  }

  if (DIRECT_VIDEO.test(url.pathname)) {
    url.hash = "";
    return { type: "video", url: url.href };
  }
  fail("Video links must be a YouTube link or a direct .mp4, .webm or .mov file link");
}

export function parseStartSeconds(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 43200) fail("Start time must be a whole number of seconds (0 or more)");
  return n;
}
