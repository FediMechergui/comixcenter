/** OPDS catalogs from the phone: browse feeds and import books, over native HTTP with optional sign-in. */
import { transport } from "./clients";
import type { Id, LibraryFile, OpdsFeed } from "./db";
import { parseOpdsFeed } from "./library";
import { importComic } from "./libraryStore";
import { fetchGetComicsOpds, GETCOMICS_FEED, GETCOMICS_SCHEME } from "./sources/getcomics";
import { downloadBytes, downloadAddress, type DownloadOptions } from "@/lib/download-transfer";

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
  const bytes = new TextEncoder().encode(`${username}:${password ?? ""}`);
  return username ? { Authorization: `Basic ${btoa(String.fromCharCode(...bytes))}` } : {};
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

/** Direct files only: native disk streaming or a bounded browser stream, with real cancellation. */
export async function importFromOpds(feed: OpdsFeed, href: string, title?: string | null, options: DownloadOptions = {}): Promise<[LibraryFile, boolean]> {
  downloadAddress(href);
  const headers = new URL(href).origin === new URL(feed.url).origin ? authHeader(feed.username, feed.password) : {};
  const bytes = await downloadBytes(href, headers, options);
  const source = feed.id != null && feed.id > 0 ? (feed.id as Id) : null;
  return importComic(bytes, title || new URL(href).pathname.split("/").pop() || "opds-book", options.onImportProgress, source, options.signal);
}
