import { PollVote } from "../models/PollVote.js";
import { cleanLine } from "./profileFields.js";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_OPTION = 60;
/** How long a poll stays open, in days. */
export const POLL_DAYS = [1, 3, 7];
const DAY = 24 * 60 * 60 * 1000;

/**
 * The poll a new post asks for: `{ options: ["Yes", "No"], days: 1 }`, two to four short options (each one line of up to 60 characters, no two the
 * same) open for one, three or seven days. Returns { poll } (null when the post has none) or { error }.
 */
export function readPoll(input, now = Date.now()) {
  if (input === undefined || input === null) return { poll: null };
  if (typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.options)) return { error: "A poll needs a list of options" };
  const options = [];
  for (const raw of input.options) {
    if (typeof raw !== "string") return { error: "Poll options must be text" };
    const text = cleanLine(raw);
    if (!text) return { error: "Poll options can't be empty" };
    if ([...text].length > MAX_OPTION) return { error: `A poll option can be up to ${MAX_OPTION} characters` };
    options.push(text);
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return { error: `A poll needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options` };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: "Poll options must all be different" };
  const days = input.days === undefined ? 1 : input.days;
  if (!POLL_DAYS.includes(days)) return { error: "A poll can be open for 1, 3 or 7 days" };
  return { poll: { options, endsAt: new Date(now + days * DAY) } };
}

export const hasPoll = (post) => Array.isArray(post?.poll?.options) && post.poll.options.length > 0;
export const isClosed = (post, now = Date.now()) => new Date(post.poll.endsAt).getTime() <= now;

/** How each poll among these posts stands: Map of post id → { counts: [per option], mine: the viewer's option or null }. */
export async function pollTallies(posts, viewerId) {
  const withPolls = posts.filter(hasPoll);
  const out = new Map();
  if (withPolls.length === 0) return out;
  const ids = withPolls.map((p) => p._id);
  const grouped = await PollVote.aggregate([{ $match: { post: { $in: ids } } }, { $group: { _id: { post: "$post", option: "$option" }, n: { $sum: 1 } } }]);
  const mine = viewerId ? await PollVote.find({ post: { $in: ids }, user: viewerId }).select("post option").lean() : [];
  for (const post of withPolls) out.set(String(post._id), { counts: post.poll.options.map(() => 0), mine: null });
  for (const g of grouped) {
    const tally = out.get(String(g._id.post));
    if (tally && g._id.option < tally.counts.length) tally.counts[g._id.option] = g.n;
  }
  for (const v of mine) {
    const tally = out.get(String(v.post));
    if (tally) tally.mine = v.option;
  }
  return out;
}

/** The poll as people see it: options with their votes, the total, when it ends, whether it has, and what the viewer chose. */
export function publicPoll(post, tally, now = Date.now()) {
  const counts = tally?.counts ?? post.poll.options.map(() => 0);
  return {
    options: post.poll.options.map((text, i) => ({ text, votes: counts[i] ?? 0 })),
    total: counts.reduce((a, b) => a + b, 0),
    endsAt: post.poll.endsAt,
    closed: isClosed(post, now),
    myVote: tally?.mine ?? null,
  };
}
