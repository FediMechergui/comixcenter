/** OPDS catalogs from the phone: browse feeds and import books, over native HTTP with optional sign-in. */
import { transport } from "./clients";
import type { Id, LibraryFile, OpdsFeed } from "./db";
import { parseOpdsFeed } from "./library";
import { importComic } from "./libraryStore";

function authHeader(username?: string | null, password?: string | null): Record<string, string> {
  return username ? { Authorization: `Basic ${btoa(`${username}:${password ?? ""}`)}` } : {};
}

function checkUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) OPDS addresses are supported");
}

export async function browseOpds(url: string, username?: string | null, password?: string | null) {
  checkUrl(url);
  const resp = await transport()({ url, responseType: "text", timeoutMs: 30000,
    headers: { Accept: "application/atom+xml, */*", ...authHeader(username, password) } });
  if (resp.status === 401 || resp.status === 403) throw new Error("The server refused the username or password");
  if (resp.status >= 400) throw new Error(`The server answered ${resp.status}`);
  return { ...parseOpdsFeed(String(resp.data), url), url };
}

export async function importFromOpds(feed: OpdsFeed, href: string, title?: string | null): Promise<[LibraryFile, boolean]> {
  checkUrl(href);
  const resp = await transport()({ url: href, responseType: "arraybuffer", timeoutMs: 10 * 60_000, headers: authHeader(feed.username, feed.password) });
  if (resp.status >= 400) throw new Error(`Download failed (${resp.status})`);
  const bytes = resp.data instanceof Uint8Array ? resp.data : new Uint8Array(resp.data as ArrayBuffer);
  return importComic(bytes, title || href.split("/").pop() || "opds-book", undefined, feed.id as Id);
}
