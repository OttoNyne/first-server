// #hashtags: naming a topic in a post or a caption, as #ceramics. The text stays plain text; this finds the tags in it, so the posts and pieces
// about a topic can be found together on the Explore page.

/** The most tags that count in one post or caption. */
export const MAX_TAGS = 10;

// A # that starts a word (not inside a longer one, an HTML entity such as &#39; or a run of #s), then 2 to 30 letters, numbers or
// underscores with at least one letter (so "#12" in "issue #12" is not a topic).
const HASHTAG = /(?<![\p{L}\p{N}_#&])#(?=[\p{N}_]*\p{L})([\p{L}\p{N}_]{2,30})(?![\p{L}\p{N}_])/gu;
const WHOLE = /^(?=[\p{N}_]*\p{L})[\p{L}\p{N}_]{2,30}$/u;

/** The tags in some text, lower-cased, each once, in order, at most MAX_TAGS of them. */
export function hashtagsIn(text) {
  if (typeof text !== "string" || !text.includes("#")) return [];
  const tags = [];
  for (const match of text.matchAll(HASHTAG)) {
    const tag = match[1].toLocaleLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** A tag asked for in an address or a search ("#Ceramics", "ceramics"): lower-cased without the #, or null if it can't be a tag. */
export function normalizeTag(raw) {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().replace(/^#/, "").toLocaleLowerCase();
  return WHOLE.test(tag) ? tag : null;
}
