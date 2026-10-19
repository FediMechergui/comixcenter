"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import * as I from "@/components/icons";
import { useStringParam, withParams } from "@/components/params";
import { Empty, ErrorBox, Loading } from "@/components/ui";
import { api, qs, useApi } from "@/lib/api";
import type { Chapter, Chapters, ChapterPages } from "@/lib/engine/sources/batcave";
import { readingSession, saveReadingSession } from "@/lib/reading-history";
import "./online-reader.css";
import { SourceReader } from "@/components/source-reader";

let inFlight = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else inFlight++;
  try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else inFlight--; }
}

/** Keep only nearby images alive. The measured placeholder preserves scroll position. */
function RemotePage({ src, index, scroll, onVisible }: { src: string; index: number; scroll: boolean; onVisible: (i: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [near, setNear] = useState(!scroll);
  const [height, setHeight] = useState<number | undefined>();
  const holder = useRef<HTMLDivElement>(null);
  const latestVisible = useRef(onVisible);
  latestVisible.current = onVisible;
  useEffect(() => {
    if (!scroll) { setNear(true); return; }
    const el = holder.current;
    if (!el) return;
    const observer = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "900px 0px" });
    const progress = new IntersectionObserver(([e]) => { if (e.isIntersecting) latestVisible.current(index); }, { threshold: .15 });
    observer.observe(el); progress.observe(el);
    return () => { observer.disconnect(); progress.disconnect(); };
  }, [scroll, index]);
  useEffect(() => {
    if (!near) return;
    let live = true;
    let made: string | null = null;
    setFailed(false);
    withSlot(async () => {
      if (!live) return null;
      return api.get<{ base64: string; type: string }>(`/api/online/read/page?url=${encodeURIComponent(src)}`);
    }).then((r) => {
      if (!r || !live) return;
      const binary = atob(r.base64), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      made = URL.createObjectURL(new Blob([bytes], { type: r.type }));
      setUrl(made);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); setUrl(null); };
  }, [near, src, retry]);
  return <div id={`online-page-${index}`} ref={holder} className={`online-image ${scroll ? "scroll-page" : "single-page"}`} style={scroll && !url ? { minHeight: height || 650 } : undefined}>
    {failed ? <div className="online-image-state"><p>Page {index + 1} couldn’t load.</p><button onClick={() => setRetry((r) => r + 1)}>Try again</button></div>
      : url ? <img src={url} alt={`Comic page ${index + 1}`} draggable={false} onLoad={(e) => setHeight(e.currentTarget.getBoundingClientRect().height)} />
        : <div className="online-image-state" role="status">Loading page {index + 1}…</div>}
  </div>;
}

function ChapterReader({ comic, title, chapter, chapters, startPage, onChapter, onBack }: { comic: string; title: string; chapter: string; chapters: Chapter[]; startPage: number; onChapter: (c: string) => void; onBack: () => void }) {
  const data = useApi<ChapterPages>(`/api/online/read/pages${qs({ url: comic, chapter })}`, { shouldRetryOnError: false });
  const [mode, setMode] = useState<"single" | "scroll">("single");
  const [page, setPage] = useState(Math.max(0, startPage));
  const [chrome, setChrome] = useState(true);
  const scrollResumed = useRef(false);
  const total = data.data?.pages.length || 0;
  const current = Math.min(page, Math.max(0, total - 1));
  const chapterIndex = chapters.findIndex((c) => c.id === chapter);
  const chapterTitle = chapters[chapterIndex]?.title || `Issue ${chapter}`;
  useEffect(() => { try { const v = localStorage.getItem("comix.online-mode"); if (v === "scroll") setMode(v); } catch { /* default */ } }, []);
  useEffect(() => {
    if (mode !== "scroll" || !total || scrollResumed.current) return;
    scrollResumed.current = true;
    const frame = requestAnimationFrame(() => document.getElementById(`online-page-${Math.min(startPage, total - 1)}`)?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [mode, total, startPage]);
  useEffect(() => {
    if (!total) return;
    const timer = setTimeout(() => saveReadingSession({ url: comic, title, chapter, chapterTitle, page: current, updated: new Date().toISOString() }), 400);
    return () => clearTimeout(timer);
  }, [comic, title, chapter, chapterTitle, current, total]);
  const go = useCallback((delta: number) => setPage((p) => Math.max(0, Math.min(total - 1, p + delta))), [total]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, select, button, textarea")) return;
      if (e.key === "Escape") setChrome((v) => !v);
      if (mode !== "single") return;
      if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(1); }
      if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [mode, go]);
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {}); else void document.documentElement.requestFullscreen?.().catch(() => {}); };
  return <div className={`online-reader ${chrome ? "" : "chrome-hidden"}`}>
    <header className="online-toolbar"><button onClick={onBack} aria-label="All chapters"><I.ChevronL /></button><div className="online-reader-title"><strong>{title}</strong><span>{chapterTitle}</span></div>
      <select aria-label="Chapter" value={chapter} onChange={(e) => onChapter(e.target.value)}>{chapters.map((c) => <option value={c.id} key={c.id}>{c.number}</option>)}</select>
      <button onClick={() => { const next = mode === "single" ? "scroll" : "single"; scrollResumed.current = true; setMode(next); if (next === "scroll") requestAnimationFrame(() => document.getElementById(`online-page-${current}`)?.scrollIntoView()); else window.scrollTo(0, 0); try { localStorage.setItem("comix.online-mode", next); } catch { /* session preference */ } }} aria-label={`Switch to ${mode === "single" ? "scroll" : "page"} mode`}>{mode === "single" ? "Scroll" : "Pages"}</button><button onClick={fullscreen} aria-label="Toggle fullscreen"><I.Expand /></button>
    </header>
    <div className="online-reader-message"><SourceReader url={comic} /></div>
    {data.error && <div className="online-reader-message"><ErrorBox error={data.error} retry={() => data.mutate()} /></div>}
    {data.isLoading && <div className="online-reader-message"><Loading lines={5} /><p>Opening the chapter…</p></div>}
    {total > 0 && <>
      {mode === "single" ? <div className="online-stage"><RemotePage key={data.data!.pages[current]} src={data.data!.pages[current]} index={current} scroll={false} onVisible={setPage} />
        <button className="online-turn turn-prev" aria-label="Previous page" disabled={current === 0} onClick={() => go(-1)}><I.ChevronL /></button><button className="online-turn turn-next" aria-label="Next page" disabled={current === total - 1} onClick={() => go(1)}><I.ChevronR /></button>
      </div> : <div className="online-scroll">{data.data!.pages.map((src, i) => <RemotePage key={src} src={src} index={i} scroll onVisible={setPage} />)}</div>}
      <footer className="online-controls"><button aria-label="Previous chapter" disabled={chapterIndex <= 0} onClick={() => onChapter(chapters[chapterIndex - 1].id)}><I.ChevronL /><span>Issue</span></button>
        <label className="online-page-range"><span>{current + 1} / {total}</span><input aria-label="Page" type="range" min={0} max={total - 1} value={current} onChange={(e) => { const n = Number(e.target.value); setPage(n); if (mode === "scroll") { setMode("single"); } }} /></label>
        <button aria-label="Next chapter" disabled={chapterIndex < 0 || chapterIndex >= chapters.length - 1} onClick={() => onChapter(chapters[chapterIndex + 1].id)}><span>Issue</span><I.ChevronR /></button>
      </footer>
      {mode === "single" && current === total - 1 && chapterIndex < chapters.length - 1 && <button className="online-next-chapter" onClick={() => onChapter(chapters[chapterIndex + 1].id)}>Continue to the next issue<I.ChevronR /></button>}
    </>}
    <button className="reader-show-controls" onClick={() => setChrome((v) => !v)} aria-label={chrome ? "Hide reader controls" : "Show reader controls"}><I.Gear /></button>
  </div>;
}

function OnlineBook({ comic, title, startAt, number }: { comic: string; title: string; startAt: string | null; number: string | null }) {
  const result = useApi<Chapters>(`/api/online/read/chapters${qs({ url: comic })}`, { shouldRetryOnError: false });
  const [chapter, setChapter] = useState<string | null>(null);
  const [startPage, setStartPage] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [filter, setFilter] = useState("");
  const [moreChapters, setMoreChapters] = useState<Chapter[]>([]);
  const [nextStart, setNextStart] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const allChapters = [...(result.data?.chapters || []), ...moreChapters];
  useEffect(() => { if (result.data) setNextStart(result.data.next_start || null); }, [result.data]);
  useEffect(() => {
    if (!result.data || initialized) return;
    setInitialized(true);
    const saved = readingSession(comic);
    const linkedNumber = /\/comic\/[^/]+\/([\d.]+)\/?$/.exec(new URL(comic).pathname)?.[1];
    const wantedNumber = number || linkedNumber;
    const target = startAt || (wantedNumber ? result.data.chapters.find((c) => c.number === wantedNumber)?.id : saved?.chapter);
    if (target && result.data.chapters.some((c) => c.id === target)) { setChapter(target); setStartPage(saved?.chapter === target ? saved.page : 0); }
  }, [result.data, initialized, comic, startAt, number]);
  function pick(id: string) { setStartPage(0); setChapter(id); window.scrollTo(0, 0); }
  if (chapter && result.data) return <ChapterReader key={chapter} comic={comic} title={title} chapter={chapter} chapters={allChapters} startPage={startPage} onChapter={pick} onBack={() => setChapter(null)} />;
  return <div className="chapter-picker"><Link className="text-link" href="/"><I.ChevronL />Discover</Link><span className="eyebrow">Read online / {result.data?.source || "Batcave"}</span><h1 className="title">{title}</h1><p className="muted">Choose an issue. Your place is saved as you read.</p>
    <SourceReader url={comic} />
    {result.error && <ErrorBox error={result.error} retry={() => result.mutate()} />}{result.isLoading && <Loading lines={5} />}
    {result.data && <><div className="between"><span className="mono">{result.data.chapters.length} issues</span><label className="visually-hidden" htmlFor="chapter-filter">Find an issue</label><input className="input guide-search" id="chapter-filter" placeholder="Find an issue number" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
      <div className="chapter-grid">{allChapters.filter((c) => c.title.toLowerCase().includes(filter.toLowerCase())).map((c) => <button onClick={() => pick(c.id)} key={c.id}><span className="mono">Issue</span><strong>{c.number}</strong><span>{c.title}</span><I.ChevronR /></button>)}</div>
      {nextStart && <button className="btn secondary" disabled={loadingMore} onClick={async () => { setLoadingMore(true); setMoreError(null); try { const data = await api.get<Chapters>(`/api/online/read/chapters${qs({ url: comic, start: nextStart })}`); setMoreChapters((rows) => [...rows, ...data.chapters.filter((c) => !allChapters.some((a) => a.id === c.id))]); setNextStart(data.next_start || null); } catch (e) { setMoreError(e); } finally { setLoadingMore(false); } }}>{loadingMore ? "Checking the next issues…" : "Load more issues"}</button>}{moreError && <ErrorBox error={moreError} />}</>}
  </div>;
}

function ReadOnline() {
  const url = useStringParam("url");
  const slug = useStringParam("slug");
  const startAt = useStringParam("chapter");
  const number = useStringParam("number");
  const title = useStringParam("title") || "Read online";
  const comic = url || (slug ? `https://readcomicsonline.ru/comic/${slug}` : null);
  if (!comic) return <Empty title="Choose a comic to read" action={<Link className="btn" href="/">Discover comics</Link>}>Browse a source or open a reading guide.</Empty>;
  return <OnlineBook key={comic} comic={comic} title={title} startAt={startAt} number={number} />;
}
export default withParams(ReadOnline);
