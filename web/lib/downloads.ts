"use client";
import { useEffect, useSyncExternalStore } from "react";
import { refresh } from "@/lib/api";
import { checkCancelled, downloadAddress, recoverDownloadFiles } from "@/lib/download-transfer";

export type DownloadPhase = "downloading" | "importing" | "cancelling" | "saved" | "failed" | "cancelled" | "interrupted";
export interface DownloadJob {
  id: string; feedId: number; href: string; title: string; phase: DownloadPhase;
  received: number; total?: number; pages?: number; pageTotal?: number; error?: string; fileId?: number; updated: string; noticeHidden?: boolean;
}
const KEY = "comix.downloads.v1";
const empty: DownloadJob[] = [];
let jobs: DownloadJob[] = [], loaded = false;
let active: { id: string; controller: AbortController } | null = null;
let recovered = false;
const subscribers = new Set<() => void>();
export function isDownloading(job: DownloadJob) { return ["downloading", "importing", "cancelling"].includes(job.phase); }
function snapshot() {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(value)) jobs = value.filter((j) => j && typeof j.id === "string" && typeof j.title === "string" && typeof j.href === "string" && Number.isInteger(j.feedId) && ["downloading","importing","cancelling","saved","failed","cancelled","interrupted"].includes(j.phase)).slice(0,12).map((j) => ({ ...j, phase: isDownloading(j) ? "interrupted" : j.phase }));
    } catch { /* Storage is optional; current transfers still work. */ }
  }
  return jobs;
}
function publish(persist = false) {
  if (persist) { try { localStorage.setItem(KEY, JSON.stringify(jobs)); } catch { /* Session-only history. */ } }
  subscribers.forEach((cb) => cb());
}
function update(id: string, changes: Partial<DownloadJob>, persist = false) {
  jobs = jobs.map((j) => j.id === id ? { ...j, ...changes, updated: new Date().toISOString() } : j); publish(persist);
}
export function useDownloads() {
  useEffect(() => { if (!recovered) { recovered = true; if (!active) void recoverDownloadFiles().catch(() => {}); } }, []);
  return useSyncExternalStore((cb) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; }, snapshot, () => empty);
}

/** Transfer continues across navigation while this app process is alive. No silent auto-retries. */
export function startDownload(feedId: number, href: string, title: string) {
  snapshot(); downloadAddress(href);
  if (active) throw new Error("Finish or cancel the current download first.");
  const id = crypto.randomUUID(), controller = new AbortController();
  active = { id, controller };
  jobs = [{ id, feedId, href, title, phase: "downloading" as const, received: 0, updated: new Date().toISOString() }, ...jobs].slice(0,12); publish(true);
  void (async () => {
    try {
      const { initEngine } = await import("@/lib/engine"); await initEngine();
      checkCancelled(controller.signal);
      const [{ db }, { builtinFeed, importFromOpds }] = await Promise.all([import("@/lib/engine/db"), import("@/lib/engine/opdsClient")]);
      const feed = builtinFeed(feedId) || await db().opdsFeeds.get(feedId);
      if (!feed) throw new Error("This source feed is no longer available. Add it again before retrying.");
      const [file] = await importFromOpds(feed, href, title, {
        signal: controller.signal,
        onProgress: (p) => { if (!controller.signal.aborted) update(id, { received: p.received, total: p.total }); },
        onImportProgress: (pages, pageTotal) => { if (!controller.signal.aborted) update(id, { phase: "importing", pages, pageTotal }, pages === 1); },
      });
      update(id, { phase: "saved", fileId: file.id }, true);
      refresh("/api/library", "/api/device/storage", "/api/status");
    } catch (error) {
      update(id, { phase: controller.signal.aborted ? "cancelled" : "failed", error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : "The comic could not be saved" }, true);
    } finally { active = null; publish(); }
  })();
  return id;
}
export function cancelDownload(id: string) {
  if (active?.id !== id) return;
  update(id, { phase: "cancelling" }, true); active.controller.abort();
}
export function dismissDownload(id: string) { if (active?.id === id) return; jobs = snapshot().filter((j) => j.id !== id); publish(true); }
export function hideDownloadNotice(id: string) { update(id, { noticeHidden: true }, true); }
