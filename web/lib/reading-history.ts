"use client";
import { useSyncExternalStore } from "react";

const KEY = "comix.reading-history.v1";
export interface ReadingSession { url: string; title: string; chapter: string; chapterTitle: string; page: number; updated: string; reader?: "source" | "app"; resumeUrl?: string; sourcePage?: string; scroll?: number }
let cached: ReadingSession[] = [];
let raw: string | null = null;
const empty: ReadingSession[] = [];
function snapshot() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== raw) {
      raw = stored;
      const parsed = JSON.parse(stored || "[]");
      cached = Array.isArray(parsed) ? parsed.filter((x) => typeof x?.url === "string" && typeof x?.title === "string" && typeof x?.chapter === "string").slice(0, 24) : [];
    }
  } catch { /* unavailable storage */ }
  return cached;
}
function subscribe(cb: () => void) {
  window.addEventListener("comix-reading", cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener("comix-reading", cb); window.removeEventListener("storage", cb); };
}
export function useReadingHistory() { return useSyncExternalStore(subscribe, snapshot, () => empty); }
export function saveReadingSession(session: ReadingSession) {
  const next = [session, ...snapshot().filter((s) => s.url !== session.url)].slice(0, 24);
  try { localStorage.setItem(KEY, JSON.stringify(next)); window.dispatchEvent(new Event("comix-reading")); } catch { /* reading still works */ }
}
export function readingSession(url: string) { return snapshot().find((s) => s.url === url); }
