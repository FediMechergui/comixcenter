/** OPDS catalogs from the phone: browse feeds and import books, over native HTTP with optional sign-in. */
import { transport } from "./clients";
import type { Id, LibraryFile, OpdsFeed } from "./db";
import { parseOpdsFeed } from "./library";
import { importComic, ImportError } from "./libraryStore";
import { fetchGetComicsOpds, GETCOMICS_FEED, GETCOMICS_SCHEME } from "./sources/getcomics";

/**
 * Feeds the app ships with. They have no database row, so they carry negative ids to stay clear
 * of Dexie's autoincrement and are resolved here rather than through opdsFeeds.get().
 */
const BUILTIN_FEEDS: OpdsFeed[] = [
  { ...GETCOMICS_FEED, username: null, password: null, created_at: "" },
];

export const builtinFeeds = (): OpdsFeed[] => BUILTIN_FEEDS;
export const builtinFeed = (id: number): OpdsFeed | null => BUILTIN_FEEDS.find((f) => f.id === id) ?? null;

function authHeader(username?: string | null, password?: string | null): Record<string, string> {
  return username ? { Authorization: `Basic ${btoa(`${username}:${password ?? ""}`)}` } : {};
}

function checkUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) OPDS addresses are supported");
}

export async function browseOpds(url: string, username?: string | null, password?: string | null) {
  if (url.startsWith(GETCOMICS_SCHEME)) return await fetchGetComicsOpds(url);
  checkUrl(url);
  const resp = await transport()({ url, responseType: "text", timeoutMs: 30000,
    headers: { Accept: "application/atom+xml, */*", ...authHeader(username, password) } });
  if (resp.status === 401 || resp.status === 403) throw new Error("The server refused the username or password");
  if (resp.status >= 400) throw new Error(`The server answered ${resp.status}`);
  return { ...parseOpdsFeed(String(resp.data), url), url };
}

/**
 * An import is read into memory whole (base64 over the bridge, then the bytes, then the unpack),
 * and the native layer dies with an OutOfMemoryError it never reports back, leaving the download
 * hanging forever. GetComics volume collections run past 200 MB, so the size is checked up front
 * and refused with a message instead.
 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

async function checkSize(href: string, headers: Record<string, string>) {
  let length: string | undefined;
  try {
    const head = await transport()({ url: href, method: "HEAD", responseType: "text", timeoutMs: 60_000, headers });
    length = head.headers["content-length"];
  } catch {
    return; // A server that will not answer HEAD still gets its chance below.
  }
  const size = Number(length);
  if (Number.isFinite(size) && size > MAX_IMPORT_BYTES) {
    throw new ImportError(`That book is ${MB(size)}; the phone can import up to ${MB(MAX_IMPORT_BYTES)} at a time.`);
  }
}

export async function importFromOpds(feed: OpdsFeed, href: string, title?: string | null): Promise<[LibraryFile, boolean]> {
  checkUrl(href);
  const headers = new URL(href).origin === new URL(feed.url).origin ? authHeader(feed.username, feed.password) : {};
  await checkSize(href, headers);
  const resp = await transport()({ url: href, responseType: "arraybuffer", timeoutMs: 10 * 60_000, headers });
  if (resp.status >= 400) throw new Error(`Download failed (${resp.status})`);
  const bytes = resp.data instanceof Uint8Array ? resp.data : new Uint8Array(resp.data as ArrayBuffer);
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportError(`That book exceeds the ${MB(MAX_IMPORT_BYTES)} import limit.`);
  // A built-in feed has no row to point at, so the file is filed without a source feed.
  const source = feed.id != null && feed.id > 0 ? (feed.id as Id) : null;
  return importComic(bytes, title || href.split("/").pop() || "opds-book", undefined, source);
}
