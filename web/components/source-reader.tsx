"use client";
import { useEffect, useState } from "react";
import { registerPlugin } from "@capacitor/core";
import { isNativeApp } from "@/lib/native";

const SourceBrowser = registerPlugin<{ open(options: { url: string }): Promise<void> }>("SourceBrowser");

/** Opens source content in the APK's separate browser, preserving the phone's source session. */
export function SourceReader({ url }: { url: string }) {
  const [native, setNative] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setNative(isNativeApp()), []);
  if (!native) return null;
  return <div className="source-reader-option">
    <button className="btn secondary" onClick={async () => {
      setError("");
      try { await SourceBrowser.open({ url }); }
      catch (e) { setError(e instanceof Error ? e.message : "The source reader could not open."); }
    }}>Open source reader in app</button>
    <p className="small muted">If pages are blocked, use the source reader and complete any verification there. Close returns here.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
