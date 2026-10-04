"use client";
// Offline copies of comics: page images kept in Cache Storage, read back as blob URLs.
import { apiUrl } from "@/lib/api";

const CACHE = "comix-offline-v1";
export const READER_WIDTH = 1280;

export function pageUrl(fileId: number, index: number, width = READER_WIDTH) {
  return apiUrl(`/api/library/${fileId}/pages/${index}?w=${width}`);
}

function cachesAvailable() {
  return typeof window !== "undefined" && "caches" in window;
}

/** Object URL for a page: the offline copy when there is one, otherwise the network. */
export async function loadPage(url: string): Promise<string> {
  if (cachesAvailable()) {
    try {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(url);
      if (hit) return URL.createObjectURL(await hit.blob());
    } catch { /* storage unavailable: fall back to network */ }
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Page failed to load (${resp.status})`);
  return URL.createObjectURL(await resp.blob());
}

export async function savedPageCount(fileId: number, pages: number): Promise<number> {
  if (!cachesAvailable()) return 0;
  try {
    const cache = await caches.open(CACHE);
    let n = 0;
    for (let i = 0; i < pages; i++) if (await cache.match(pageUrl(fileId, i))) n++;
    return n;
  } catch { return 0; }
}

// Which comics are saved, so the library can list them while the server is unreachable
const INDEX_KEY = "comix.offline.index";
export interface OfflineEntry { id: number; title: string; pages: number; savedAt: string }

export function offlineIndex(): OfflineEntry[] {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || "[]"); } catch { return []; }
}

function writeIndex(entries: OfflineEntry[]) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(entries)); } catch { /* storage full or blocked */ }
}

/** A cached API response (e.g. a saved comic's details) for when the server can't be reached. */
export async function cachedJson<T>(url: string): Promise<T | undefined> {
  if (!cachesAvailable()) return undefined;
  try {
    const hit = await (await caches.open(CACHE)).match(url);
    return hit ? ((await hit.json()) as T) : undefined;
  } catch { return undefined; }
}

export async function saveOffline(fileId: number, pages: number, onProgress?: (done: number) => void, title?: string): Promise<void> {
  if (!cachesAvailable()) throw new Error("This browser can't store comics offline.");
  const cache = await caches.open(CACHE);
  const details = apiUrl(`/api/library/${fileId}`);
  const meta = await fetch(details);
  if (!meta.ok) throw new Error(`Couldn't load this comic's details (${meta.status})`);
  await cache.put(details, meta);
  for (let i = 0; i < pages; i++) {
    const url = pageUrl(fileId, i);
    if (!(await cache.match(url))) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Page ${i + 1} failed to download (${resp.status})`);
      await cache.put(url, resp);
    }
    onProgress?.(i + 1);
  }
  writeIndex([...offlineIndex().filter((e) => e.id !== fileId),
    { id: fileId, title: title ?? `Comic ${fileId}`, pages, savedAt: new Date().toISOString() }]);
}

export async function removeOffline(fileId: number, pages: number): Promise<void> {
  writeIndex(offlineIndex().filter((e) => e.id !== fileId));
  if (!cachesAvailable()) return;
  const cache = await caches.open(CACHE);
  await Promise.all([cache.delete(apiUrl(`/api/library/${fileId}`)),
    ...Array.from({ length: pages }, (_, i) => cache.delete(pageUrl(fileId, i)))]);
}
