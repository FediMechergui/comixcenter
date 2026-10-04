"use client";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as I from "@/components/icons";
import { useNumberParam, withParams } from "@/components/params";
import { ErrorBox, Loading } from "@/components/ui";
import { api, refresh, useApi } from "@/lib/api";
import { loadPage, pageUrl } from "@/lib/offline";
import type { LibraryFile } from "@/lib/types";
import "./reader.css";

type Mode = "single" | "double" | "webtoon" | "guided";
const PREFS = "comix.reader";

interface Prefs { mode: Mode; rtl: boolean }

function readPrefs(): Prefs {
  try { return { mode: "single", rtl: false, ...JSON.parse(localStorage.getItem(PREFS) || "{}") }; } catch { return { mode: "single", rtl: false }; }
}

/** An image that resolves through the offline cache; loads when near the viewport if `lazy`. */
function PageImage({ fileId, index, lazy, className, style, alt, onSize }: {
  fileId: number; index: number; lazy?: boolean; className?: string; style?: React.CSSProperties; alt: string;
  onSize?: (w: number, h: number) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!lazy);
  useEffect(() => {
    if (!lazy || visible) return;
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setVisible(true); }, { rootMargin: "1200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, visible]);
  useEffect(() => {
    if (!visible) return;
    let url: string | null = null;
    let live = true;
    setFailed(false);
    loadPage(pageUrl(fileId, index)).then((u) => { url = u; if (live) setSrc(u); else URL.revokeObjectURL(u); }).catch(() => live && setFailed(true));
    return () => { live = false; if (url) URL.revokeObjectURL(url); setSrc(null); };
  }, [fileId, index, visible]);
  if (failed) return <div className={`reader-missing ${className ?? ""}`} style={style}>Page {index + 1} couldn&rsquo;t load. Check your connection or save this comic for offline reading.</div>;
  if (!src) return <div ref={holder} className={`reader-pending ${className ?? ""}`} style={style} aria-label={`Loading page ${index + 1}`} />;
  return <img src={src} alt={alt} className={className} style={style} draggable={false}
    onLoad={(e) => onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />;
}

function Reader() {
  const fileId = useNumberParam("file");
  const { data: file, error, mutate } = useApi<LibraryFile>(fileId ? `/api/library/${fileId}` : null);
  const [prefs, setPrefs] = useState<Prefs>({ mode: "single", rtl: false });
  const [page, setPage] = useState<number | null>(null);
  const [chrome, setChrome] = useState(true);
  // Guided view: which panel; "last" when arriving on a page by going backwards
  const [panel, setPanel] = useState<number | "last">(0);
  const guidedNav = useRef<((delta: number) => void) | null>(null);
  useEffect(() => setPrefs(readPrefs()), []);
  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* ignore */ } }, [prefs]);
  useEffect(() => { if (file && page === null) setPage(file.finished ? 0 : Math.min(file.current_page, file.page_count - 1)); }, [file, page]);

  // Save position (debounced); the server marks the issue read on the last page
  useEffect(() => {
    if (!file || page === null) return;
    const t = setTimeout(() => {
      api.put<{ finished: boolean }>(`/api/library/${file.id}/position`, { page }).then((r) => {
        if (r.finished) refresh("/api/progress", "/api/orders", "/api/issues", "/api/library");
      }).catch(() => { /* offline: position saved next time */ });
    }, 600);
    return () => clearTimeout(t);
  }, [file, page]);

  const total = file?.page_count ?? 0;
  const step = prefs.mode === "double" ? 2 : 1;
  const go = useCallback((delta: number) => {
    setPage((p) => {
      if (p === null) return p;
      let next = p + delta * step;
      if (prefs.mode === "double" && p === 0 && delta > 0) next = 1;           // cover stands alone
      if (prefs.mode === "double" && delta < 0 && next < 1 && p > 0) next = 0;
      return Math.max(0, Math.min(total - 1, next));
    });
    setPanel(delta > 0 ? 0 : "last");
  }, [step, total, prefs.mode]);
  const navigate = useCallback((delta: number) => {
    if (prefs.mode === "guided" && guidedNav.current) guidedNav.current(delta); else go(delta);
  }, [go, prefs.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (prefs.mode === "webtoon") return;
      const fwd = prefs.rtl ? "ArrowLeft" : "ArrowRight", back = prefs.rtl ? "ArrowRight" : "ArrowLeft";
      if (e.key === fwd || e.key === " " || e.key === "PageDown") { e.preventDefault(); navigate(1); }
      if (e.key === back || e.key === "PageUp") { e.preventDefault(); navigate(-1); }
      if (e.key === "Escape") setChrome((c) => !c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, prefs]);

  if (error) return <div className="reader"><div style={{ padding: 20 }}><ErrorBox error={error} retry={() => mutate()} /></div></div>;
  if (!file || page === null) return <div className="reader"><div style={{ padding: 20 }}><Loading /></div></div>;

  const title = file.issue ? `${file.issue.series_name} #${file.issue.number}` : file.name;
  const tap = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const forward = prefs.rtl ? x < 0.33 : x > 0.67;
    const back = prefs.rtl ? x > 0.67 : x < 0.33;
    if (forward) navigate(1);
    else if (back) navigate(-1);
    else setChrome((c) => !c);
  };

  return (
    <div className={`reader mode-${prefs.mode}${chrome ? " chrome" : ""}`}>
      <header className="reader-bar top" aria-hidden={!chrome}>
        <Link href={file.issue ? `/issue?id=${file.issue.id}` : `/file?id=${file.id}`} className="reader-btn" aria-label="Close reader"><I.ChevronL /></Link>
        <strong className="reader-title">{title}</strong>
        <span className="reader-count">{page + 1} / {total}</span>
      </header>

      {prefs.mode === "webtoon"
        ? <Webtoon file={file} start={page} onPage={setPage} onTap={() => setChrome((c) => !c)} />
        : prefs.mode === "guided"
          ? <Guided file={file} page={page} panel={panel} setPanel={setPanel} rtl={prefs.rtl} onPageChange={go} onTap={tap} navRef={guidedNav} />
          : (
            <div className="reader-stage" onClick={tap}>
              <Spread file={file} page={page} double={prefs.mode === "double"} rtl={prefs.rtl} />
            </div>
          )}

      <footer className="reader-bar bottom" aria-hidden={!chrome}>
        {prefs.mode !== "webtoon" && (
          <input type="range" min={1} max={total} value={page + 1} aria-label="Page" className="reader-slider"
            style={{ direction: prefs.rtl ? "rtl" : "ltr" }} onChange={(e) => { setPage(Number(e.target.value) - 1); setPanel(0); }} />
        )}
        <div className="reader-tools">
          {([["single", I.Single, "Single page"], ["double", I.Double, "Two pages"], ["webtoon", I.Scroll, "Vertical scroll"], ["guided", I.Panels, "Panel by panel"]] as const).map(([m, Icon, label]) => (
            <button key={m} className="reader-btn" aria-pressed={prefs.mode === m} aria-label={label} title={label}
              onClick={() => { setPrefs({ ...prefs, mode: m }); setPanel(0); }}><Icon /></button>
          ))}
          <button className="reader-btn text" aria-pressed={prefs.rtl} onClick={() => setPrefs({ ...prefs, rtl: !prefs.rtl })}
            title="Right-to-left (manga)">{prefs.rtl ? "RTL" : "LTR"}</button>
        </div>
      </footer>
    </div>
  );
}

function Spread({ file, page, double, rtl }: { file: LibraryFile; page: number; double: boolean; rtl: boolean }) {
  const pages = double && page > 0 && page + 1 < file.page_count ? [page, page + 1] : [page];
  const ordered = rtl ? [...pages].reverse() : pages;
  return (
    <div className={`reader-spread n${ordered.length}`}>
      {ordered.map((p) => <PageImage key={p} fileId={file.id} index={p} className="reader-page" alt={`Page ${p + 1}`} />)}
      {/* Prefetch the next spread */}
      <div hidden>{[page + pages.length, page + pages.length + 1].filter((p) => p < file.page_count).slice(0, double ? 2 : 1)
        .map((p) => <PageImage key={`pre${p}`} fileId={file.id} index={p} alt="" />)}</div>
    </div>
  );
}

function Webtoon({ file, start, onPage, onTap }: { file: LibraryFile; start: number; onPage: (p: number) => void; onTap: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!scrolled.current) {
      scrolled.current = true;
      el.querySelector<HTMLElement>(`[data-page="${start}"]`)?.scrollIntoView();
    }
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.page)).sort((a, b) => a - b)[0];
      if (top !== undefined) onPage(top);
    }, { root: el, threshold: 0.5 });
    el.querySelectorAll("[data-page]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [file.id, onPage, start]);
  return (
    <div className="reader-scroll" ref={box} onClick={onTap}>
      {Array.from({ length: file.page_count }, (_, i) => (
        <div key={i} data-page={i} className="reader-strip">
          <PageImage fileId={file.id} index={i} lazy alt={`Page ${i + 1}`} className="reader-strip-img" />
        </div>
      ))}
    </div>
  );
}

/** Guided view: zooms from panel to panel using detected panel boxes. */
function Guided({ file, page, panel, setPanel, rtl, onPageChange, onTap, navRef }: {
  file: LibraryFile; page: number; panel: number | "last"; setPanel: (p: number | "last") => void; rtl: boolean;
  onPageChange: (d: number) => void; onTap: (e: React.MouseEvent<HTMLDivElement>) => void;
  navRef: React.RefObject<((delta: number) => void) | null>;
}) {
  const { data } = useApi<{ width: number; height: number; panels: number[][] }>(`/api/library/${file.id}/pages/${page}/panels?rtl=${rtl}`);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const panels = useMemo(() => data?.panels ?? [[0, 0, 1, 1]], [data]);
  const idx = panel === "last" ? panels.length - 1 : Math.max(0, Math.min(panel, panels.length - 1));

  // Next/previous panel, crossing into the neighbouring page at either end
  useEffect(() => {
    navRef.current = (delta: number) => {
      if (delta > 0) {
        if (idx < panels.length - 1) setPanel(idx + 1);
        else if (page < file.page_count - 1) onPageChange(1);
      } else if (idx > 0) setPanel(idx - 1);
      else if (page > 0) onPageChange(-1);
    };
    return () => { navRef.current = null; };
  }, [idx, panels.length, page, file.page_count, onPageChange, setPanel, navRef]);

  const [x, y, w, h] = panels[idx];
  // Fit the page to the stage, then scale so the current panel fills it
  const W = data?.width ?? 1, H = data?.height ?? 1;
  const base = box.w && box.h ? Math.min(box.w / W, box.h / H) : 0;
  const dispW = W * base, dispH = H * base;
  const s = base ? Math.min(box.w / (w * dispW), box.h / (h * dispH)) * 0.96 : 1;
  const tx = box.w / 2 - (x + w / 2) * dispW * s;
  const ty = box.h / 2 - (y + h / 2) * dispH * s;
  return (
    <div className="reader-stage guided" ref={stage} onClick={onTap}>
      {base > 0 && (
        <div className="reader-guided-page" style={{ width: dispW, height: dispH, transform: `translate(${tx}px, ${ty}px) scale(${s})` }}>
          <PageImage fileId={file.id} index={page} alt={`Page ${page + 1}, panel ${idx + 1}`} style={{ width: "100%", height: "100%" }} />
        </div>
      )}
      {base > 0 && panels.length > 1 && (
        <span className="reader-spotlight" aria-hidden style={{
          left: tx + x * dispW * s, top: ty + y * dispH * s, width: w * dispW * s, height: h * dispH * s }} />
      )}
      <span className="reader-panelcount">Panel {idx + 1} of {panels.length}</span>
    </div>
  );
}

export default withParams(Reader);
