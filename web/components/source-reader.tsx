"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { registerPlugin } from "@capacitor/core";
import { isNativeApp } from "@/lib/native";
import { readingSession, saveReadingSession } from "@/lib/reading-history";

interface Position { url?: string; page?: string; scroll?: number }
const SourceBrowser = registerPlugin<{ open(options: { url: string; resumeUrl?: string; resumePage?: string; resumeScroll?: number; resumeUpdated?: string }): Promise<Position> }>("SourceBrowser");

/** Opens source content in the APK's separate browser, preserving the phone's source session. */
export function SourceReader({ url, title = "Online comic", autoOpen = false, label = "Continue reading in app" }: { url: string; title?: string; autoOpen?: boolean; label?: string }) {
  const [native, setNative] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const opened = useRef(false);
  const open = useCallback(async () => {
    setError(""); setBusy(true);
    const saved = readingSession(url);
    saveReadingSession({ url, title, chapter: "source", chapterTitle: "Source reader", page: saved?.page || 0, updated: new Date().toISOString(), reader: "source", resumeUrl: saved?.resumeUrl || url, sourcePage: saved?.sourcePage, scroll: saved?.scroll });
    try {
      const result = await SourceBrowser.open({ url, resumeUrl: saved?.resumeUrl, resumePage: saved?.sourcePage, resumeScroll: saved?.scroll, resumeUpdated: String(Date.parse(saved?.updated || "") || 0) });
      if (result.url) {
        const match = /^Page (\d+)/.exec(result.page || "");
        saveReadingSession({ url, title, chapter: "source", chapterTitle: "Source reader", page: match ? Number(match[1]) - 1 : 0, updated: new Date().toISOString(), reader: "source", resumeUrl: result.url, sourcePage: result.page, scroll: result.scroll });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "The source reader could not open."); }
    finally { setBusy(false); }
  }, [url, title]);
  useEffect(() => setNative(isNativeApp()), []);
  useEffect(() => { if (native && autoOpen && !opened.current) { opened.current = true; void open(); } }, [native, autoOpen, open]);
  if (!native) return null;
  return <div className="source-reader-option">
    <button className="btn secondary" disabled={busy} onClick={() => void open()}>{busy ? "Reader open" : label}</button>
    <p className="small muted">Your source session and reading position stay on this phone. Complete any verification in the reader; Close returns here.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
