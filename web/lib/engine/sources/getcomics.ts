/**
 * GetComics as a built-in, OPDS-shaped feed read entirely on the phone: the site has no OPDS
 * endpoint, so its WordPress REST API is called over native HTTP (no CORS, no ComixCenter
 * server) and every post is turned into a publication entry.
 */
import { transport } from "../clients";
import type { OpdsAcquisition, OpdsEntry, OpdsFeed } from "../library/opds";

export const GETCOMICS_SCHEME = "getcomics://";

/** Listed in /api/opds without a database row behind it; see builtinFeed in opdsClient. */
export const GETCOMICS_FEED = {
  id: -1,
  name: "GetComics (Latest)",
  url: `${GETCOMICS_SCHEME}latest?page=1`,
} as const;

const API = "https://getcomics.org/wp-json/wp/v2/posts";
const PER_PAGE = 20;
const ACQUISITION = "http://opds-spec.org/acquisition";

/** The site's WAF answers 403 to unknown agents, so the requests look like a desktop browser. */
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/html, */*",
};

// ── HTML → text ──────────────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

/** Titles come back with entities (`&#8211;`); there is no DOM to lean on inside a worker. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== "#") return NAMED[body.toLowerCase()] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const asText = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

// ── Downloads ────────────────────────────────────────────────────────────────

/**
 * Android's HttpURLConnection will not follow a redirect that switches protocol, and every
 * "DOWNLOAD NOW" link is plain http that 301s to https before the 302 to the archive, so the
 * first hop is made here. Without it the download stops on the redirect and imports nothing.
 *
 * Only this button becomes a download: the other mirrors (Datanodes, Pixeldrain, TeraBox,
 * VikingFile) land on HTML pages that a direct fetch cannot turn into a file.
 */
function directDownload(href: string): string | null {
  const url = href.trim().replace(/^http:\/\//i, "https://");
  return /^https:\/\/(?:www\.)?getcomics\.(?:org|info)\/dls\//i.test(url) ? url : null;
}

/**
 * The file hosts a post links to. Only /dls/ behind a "DOWNLOAD NOW" button ends at an archive:
 * the same redirector labelled PIXELDRAIN, MEGA or TERABOX lands on that host's own web page, and
 * Datanodes answers 404 to anything that is not a browser. They are still worth recognising,
 * because a post carrying them is a comic even when the app cannot fetch it.
 */
const MIRROR_HOSTS = /(?:getcomics\.(?:org|info)\/dls\/|datanodes\.to|pixeldrain\.com|mega\.nz|terabox\.com|1024tera|vikingfile\.com|mediafire\.com)/i;

/** Downloads, the reader link, and whether this post offers any comic mirror at all. */
function linksOf(content: string): { acquisitions: OpdsAcquisition[]; reader: string | null; mirrors: number } {
  const acquisitions: OpdsAcquisition[] = [];
  const seen = new Set<string>();
  let reader: string | null = null;
  let mirrors = 0;
  // [\s\S] rather than a dotAll flag: the label often wraps onto its own line inside the anchor.
  const anchor = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = anchor.exec(content); m; m = anchor.exec(content)) {
    const href = m[1].trim();
    const label = asText(m[2]).toUpperCase();
    if (!reader && (label.includes("READ ONLINE") || /readcomicsonline/i.test(href))) {
      reader = href.replace(/^http:\/\//i, "https://");
      continue;
    }
    if (MIRROR_HOSTS.test(href)) mirrors++;
    if (!label.includes("DOWNLOAD NOW")) continue;
    const file = directDownload(href);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    acquisitions.push({ href: file, type: "application/zip", rel: ACQUISITION });
  }
  return { acquisitions, reader, mirrors };
}

// ── Posts → entries ──────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function toEntry(post: any): OpdsEntry | null {
  const rawTitle: unknown = post?.title?.rendered;
  if (typeof rawTitle !== "string" || !rawTitle.trim()) return null;
  const content: string = typeof post?.content?.rendered === "string" ? post.content.rendered : "";

  const media = post?._embedded?.["wp:featuredmedia"];
  let cover: string | null = Array.isArray(media) && typeof media[0]?.source_url === "string" ? media[0].source_url : null;
  if (!cover) cover = content.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null;

  const story = content.match(/The Story\s*[–—-]?[^<]*<\/h2>\s*<p>([\s\S]*?)<\/p>/i);
  const summary = asText(story?.[1] ?? (typeof post?.excerpt?.rendered === "string" ? post.excerpt.rendered : ""));

  const { acquisitions, reader, mirrors } = linksOf(content);
  // The site also runs sponsored articles; without a mirror or a reader it is not a comic.
  if (!mirrors && !reader) return null;
  return {
    title: decodeEntities(rawTitle).trim(),
    summary: summary || null,
    author: "GetComics",
    cover,
    kind: "publication",
    href: null,
    acquisitions,
    reader_url: reader,
  };
}

function pageOf(url: string): number {
  const page = Number(new URLSearchParams(url.split("?")[1] ?? "").get("page"));
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export async function fetchGetComicsOpds(url: string): Promise<OpdsFeed & { url: string }> {
  const page = pageOf(url);
  const res = await transport()({
    url: API,
    params: { page, per_page: PER_PAGE, _embed: 1 },
    responseType: "json",
    timeoutMs: 30_000,
    headers: HEADERS,
  });

  // Past the last page WordPress answers 400 rest_post_invalid_page_number instead of an empty list.
  const exhausted = res.status === 400 && page > 1;
  if (res.status >= 400 && !exhausted) throw new Error(`GetComics answered ${res.status}`);

  const posts: unknown[] = !exhausted && Array.isArray(res.data) ? res.data : [];
  const entries = posts.map(toEntry).filter((e): e is OpdsEntry => e !== null);

  return {
    title: GETCOMICS_FEED.name,
    url,
    entries,
    next: posts.length < PER_PAGE ? null : `${GETCOMICS_SCHEME}latest?page=${page + 1}`,
    previous: page > 1 ? `${GETCOMICS_SCHEME}latest?page=${page - 1}` : null,
    up: null,
  };
}
