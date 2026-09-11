export async function searchOpenverseImages(query) {
  let res;
  try {
    res = await fetch(
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=12&mature=false`
    );
  } catch {
    const err = new Error("Image search is unavailable right now");
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    const err = new Error("Image search is unavailable right now");
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  return (data.results || []).map((r) => ({
    id: r.id,
    url: r.url,
    thumbnailUrl: r.thumbnail,
    title: r.title,
    creator: r.creator,
  }));
}
