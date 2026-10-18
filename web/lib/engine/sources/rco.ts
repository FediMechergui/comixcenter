/**
 * Reading a comic in the app instead of handing it to a browser.
 *
 * readcomicsonline.ru itself sits behind a Cloudflare javascript challenge, so its pages cannot be
 * scraped from a WebView. Its CDN is open and laid out predictably:
 *
 *   https://cdn.readcomicsonline.ru/uploads/manga/<slug>/chapters/<chapter>/<page>.<ext>
 *
 * so chapters and pages are found by asking the CDN what exists rather than by reading any HTML.
 * The slug is the only thing taken from the link a feed gives us.
 */
import { transport } from "../clients";
import { slugify } from "../parsing";

const CDN = "https://cdn.readcomicsonline.ru/uploads/manga";

/** The CDN negotiates content, answering a .jpg request with webp where it has one. */
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
};

/** Pages and chapters are probed in parallel, a batch at a time, to keep discovery quick. */
const BATCH = 12;
const MAX_CHAPTERS = 600;
const MAX_PAGES = 200;

export interface RcoChapterPages {
  slug: string;
  chapter: string;
  pages: string[];
}

/** `https://readcomicsonline.ru/comic/red-sonja-2023` → `red-sonja-2023`. */
export function rcoSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /readcomicsonline\.ru\/comic\/([^/?#]+)/i.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

const pageUrl = (slug: string, chapter: string, page: number, pad: number, ext: string) =>
  `${CDN}/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapter)}/${String(page).padStart(pad, "0")}.${ext}`;

async function exists(url: string): Promise<boolean> {
  try {
    const res = await transport()({ url, method: "HEAD", responseType: "text", timeoutMs: 15_000, headers: HEADERS });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** Runs `fn` over `items` in parallel batches, preserving order. */
async function probe<T>(items: T[], fn: (item: T) => Promise<boolean>): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + BATCH).map(fn))));
  }
  return out;
}

/** The naming this comic uses, learned from its first page; null when the slug has nothing. */
async function firstPagePattern(slug: string, chapter: string): Promise<{ pad: number; ext: string } | null> {
  for (const { pad, ext } of [{ pad: 2, ext: "jpg" }, { pad: 2, ext: "webp" }, { pad: 3, ext: "jpg" }, { pad: 1, ext: "jpg" }]) {
    if (await exists(pageUrl(slug, chapter, 1, pad, ext))) return { pad, ext };
  }
  return null;
}

/**
 * Which chapters the CDN holds. Chapters are usually numbered from 1 without gaps, so this walks
 * forward a batch at a time and stops once a whole batch is missing rather than probing blindly.
 */
export async function rcoChapters(slug: string): Promise<string[]> {
  const found: string[] = [];
  for (let start = 1; start <= MAX_CHAPTERS; start += BATCH) {
    const numbers = Array.from({ length: BATCH }, (_, i) => start + i);
    const hits = await probe(numbers, async (n) => !!(await firstPagePattern(slug, String(n))));
    numbers.forEach((n, i) => { if (hits[i]) found.push(String(n)); });
    if (!hits.some(Boolean)) break;
  }
  return found;
}

/** Every page of one chapter, walked until the CDN runs out. */
export async function rcoPages(slug: string, chapter: string): Promise<RcoChapterPages> {
  const pattern = await firstPagePattern(slug, chapter);
  if (!pattern) return { slug, chapter, pages: [] };

  const pages: string[] = [pageUrl(slug, chapter, 1, pattern.pad, pattern.ext)];
  for (let start = 2; start <= MAX_PAGES; start += BATCH) {
    const numbers = Array.from({ length: BATCH }, (_, i) => start + i).filter((n) => n <= MAX_PAGES);
    const urls = numbers.map((n) => pageUrl(slug, chapter, n, pattern.pad, pattern.ext));
    const hits = await probe(urls, exists);
    // Pages are contiguous: the first gap is the end of the chapter, whatever follows it.
    const gap = hits.indexOf(false);
    pages.push(...(gap === -1 ? urls : urls.slice(0, gap)));
    if (gap !== -1) break;
  }
  return { slug, chapter, pages };
}

/** Only the CDN's own image paths are fetchable through the app. */
export function isRcoPage(url: string): boolean {
  return /^https:\/\/cdn\.readcomicsonline\.ru\/uploads\/manga\//i.test(url);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // btoa takes a string; the chunk keeps the argument list well inside the call-stack limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * One page's bytes, base64 for the bridge.
 *
 * The CDN sends no Access-Control-Allow-Origin, so the WebView may not fetch it from the app's
 * http://localhost origin; the native HTTP stack is not bound by that, and the screen turns what
 * comes back into a blob it can show.
 */
export async function rcoPageBytes(url: string): Promise<{ base64: string; type: string }> {
  const res = await transport()({ url, responseType: "arraybuffer", timeoutMs: 60_000, headers: HEADERS });
  if (res.status >= 400) throw new Error(`That page answered ${res.status}`);
  const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data as ArrayBuffer);
  if (!bytes.length) throw new Error("That page came back empty");
  return { base64: bytesToBase64(bytes), type: res.headers["content-type"] || "image/jpeg" };
}

/**
 * Finds a catalogue series on the CDN. Comics are named `<series>-<year>` there, so candidates are
 * built from the series' own name and start year and then tried, rather than guessed at.
 */
export async function rcoFind(series: string, year?: number | null): Promise<string | null> {
  const base = slugify(series);
  if (!base) return null;
  const stripped = base.replace(/^the-/, "");
  const candidates = [
    year ? `${base}-${year}` : null,
    base,
    year && stripped !== base ? `${stripped}-${year}` : null,
    stripped !== base ? stripped : null,
  ].filter((c): c is string => !!c);
  for (const slug of [...new Set(candidates)]) {
    if (await firstPagePattern(slug, "1")) return slug;
  }
  return null;
}
