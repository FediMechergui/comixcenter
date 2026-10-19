/** Batcave uses native HTTP where available, with the desktop browser session as a fallback. */
import { adminToken, configuredServerUrl } from "@/lib/api";
import { withDeadline } from "./http";
import { gatewayUrl, gatewayRequest } from "@/lib/gateway";
import { transport } from "../clients";
import type { OpdsFeedPage } from "@/lib/types";

export interface Chapter { id: string; title: string; number: string }
export interface Chapters { url: string; chapters: Chapter[]; source: string; next_start?: number | null }
export interface ChapterPages { url: string; chapter: string; pages: string[]; chapters: Chapter[]; source: string }
const ORIGIN = "https://batcave.biz";
const imageRefs = new Map<string, string>();
const cache = new Map<string, { expires: number; html: string }>();

export function isBatcave(url: string) {
  try { const u = new URL(url); return u.protocol === "https:" && u.hostname === "batcave.biz" && !u.username && !u.password; } catch { return false; }
}
function checked(url: string) { if (!isBatcave(url)) throw new Error("Choose a Batcave comic to read"); return url; }

async function gateway<T>(path: string): Promise<T> {
  const server = configuredServerUrl();
  if (!server && gatewayUrl()) return gatewayRequest<T>(path);
  if (!server) throw new Error("Batcave blocked the direct connection. Try GetComics below, or set up a computer in Settings → Batcave browser connection.");
  const token = adminToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${server}${path}`, { headers: token ? { "X-Admin-Token": token } : {}, signal: controller.signal });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `Batcave gateway answered ${response.status}`); }
    return await response.json();
  } catch (e) {
    throw new Error(`Batcave needs its browser session. Connect to your ComixCenter computer in Settings and retry. ${(e as Error).message}`);
  } finally { clearTimeout(timer); }
}

async function documentAt(url: string): Promise<Document> {
  checked(url);
  const cached = cache.get(url);
  let html = cached && cached.expires > Date.now() ? cached.html : "";
  if (!html) {
    const r = await withDeadline(transport()({ url, responseType: "text", timeoutMs: 8_000 }), 8_000);
    if (r.status >= 400 || typeof r.data !== "string" || /<title>\s*Just a moment/i.test(r.data)) throw new Error("Batcave needs a browser session");
    html = r.data;
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
    cache.set(url, { html, expires: Date.now() + 300_000 });
  }
  return new DOMParser().parseFromString(html, "text/html");
}

/** Parse only JSON, never execute source scripts. */
export function embeddedData(doc: Document): Record<string, unknown> {
  for (const script of doc.querySelectorAll("script")) {
    const text = script.textContent || "";
    const m = /(?:window\.)?__DATA__\s*=\s*/.exec(text);
    if (!m) continue;
    const tail = text.slice(m.index + m[0].length);
    let depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < tail.length; i++) {
      const c = tail[i];
      if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { return JSON.parse(tail.slice(0, i + 1)); }
    }
  }
  throw new Error("Batcave did not return reader data");
}

export function parseBatcaveCatalog(doc: Document) {
  const seen = new Set<string>();
  return [...doc.querySelectorAll(".latest, .readed, .short, .poster")].flatMap((item) => {
    const title = item.querySelector(".latest__title, .readed__title, .short__title, .poster__title")?.textContent?.trim();
    const href = item.querySelector("a[href]")?.getAttribute("href");
    if (!title || !href) return [];
    const url = new URL(href, ORIGIN).href;
    if (!isBatcave(url) || seen.has(url)) return [];
    seen.add(url);
    const img = item.querySelector("img");
    const src = img?.getAttribute("data-src") || img?.getAttribute("src");
    const label = item.querySelector(".latest__chapter")?.textContent?.trim().replace(/^\d{2}\.\d{2}\.\d{4}\s*[-–]\s*/, "") || title;
    return [{ title: label, summary: null, author: "Batcave", cover: src ? new URL(src, ORIGIN).href : null, kind: "publication" as const, href: null, acquisitions: [], reader_url: url }];
  });
}

function normalized(data: Record<string, unknown>): Chapter[] {
  if (!Array.isArray(data.chapters)) return [];
  return data.chapters.filter((c) => c && c.id != null).map((c) => {
    const title = String(c.title || c.name || c.id);
    return { id: String(c.id), title, number: /#\s*([\d.]+[a-z]?)/i.exec(title)?.[1] || title };
  }).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export async function batcaveCatalog(q = "", page = 1): Promise<OpdsFeedPage> {
  try {
    const url = q ? `${ORIGIN}/index.php?${new URLSearchParams({ do: "search", subaction: "search", story: q, search_start: String(page) })}` : `${ORIGIN}/${page > 1 ? `page/${page}/` : ""}`;
    const doc = await documentAt(url);
    const entries = parseBatcaveCatalog(doc);
    if (!q && !entries.length) throw new Error("Batcave returned no readable catalog");
    const more = !!doc.querySelector('a[rel="next"], .pagination__next a, a.pagination__next') || [...doc.querySelectorAll(".pagination a, .navigation a, .pagination__pages a")].some((a) => a.textContent?.trim() === String(page + 1));
    return { title: "Batcave", entries, next: more ? String(page + 1) : null, previous: page > 1 ? String(page - 1) : null, up: null, url };
  } catch { return gateway(`/api/online/catalog?${new URLSearchParams({ q, page: String(page), source: "batcave" })}`); }
}

export async function batcaveChapters(url: string): Promise<Chapters> {
  checked(url);
  try {
    const data = embeddedData(await documentAt(url));
    const chapters = normalized(data);
    if (!chapters.length) throw new Error("No chapters returned");
    return { url, chapters, source: "batcave" };
  } catch { return gateway(`/api/online/read/chapters?url=${encodeURIComponent(url)}`); }
}

export async function batcavePages(url: string, chapter: string): Promise<ChapterPages> {
  checked(url);
  try {
    const data = embeddedData(await documentAt(url));
    const chapters = normalized(data);
    if (!chapters.some((c) => c.id === chapter) || !/^\d+$/.test(String(data.news_id)) || !/^\d+$/.test(chapter)) throw new Error("Choose a chapter from this comic");
    const reader = `${ORIGIN}/reader/${data.news_id}/${chapter}`;
    const detail = embeddedData(await documentAt(reader));
    const pages = Array.isArray(detail.images) ? detail.images.filter((u): u is string => typeof u === "string" && /^https:\/\/img\.batcave\.biz\//i.test(u)) : [];
    if (!pages.length) throw new Error("No pages returned");
    for (const image of pages) imageRefs.set(image, reader);
    return { url, chapter, pages, chapters, source: "batcave" };
  } catch { return gateway(`/api/online/read/pages?${new URLSearchParams({ url, chapter })}`); }
}

export async function batcaveImage(url: string): Promise<{ base64: string; type: string }> {
  if (!/^https:\/\/img\.batcave\.biz\//i.test(url)) throw new Error("That is not a Batcave image");
  const referer = imageRefs.get(url);
  if (!referer) return gateway(`/api/online/read/page?url=${encodeURIComponent(url)}`);
  try {
    const r = await transport()({ url, responseType: "arraybuffer", timeoutMs: 45_000, headers: { Referer: referer } });
    if (r.status >= 400 || !r.headers["content-type"]?.startsWith("image/")) throw new Error("Page unavailable");
    const bytes = new Uint8Array(r.data as ArrayBuffer);
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Page exceeds 20 MB");
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(bin), type: r.headers["content-type"] };
  } catch { return gateway(`/api/online/read/page?url=${encodeURIComponent(url)}`); }
}
