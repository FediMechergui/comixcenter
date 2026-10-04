"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import * as I from "@/components/icons";
import { ToastProvider } from "@/components/ui";

const TABS = [
  { href: "/", label: "Home", icon: I.Home, match: ["/"] },
  { href: "/browse", label: "Browse", icon: I.Browse, match: ["/browse", "/publisher", "/universe", "/series", "/issue", "/arcs", "/arc", "/creator"] },
  { href: "/orders", label: "Orders", icon: I.Path, match: ["/orders", "/order"] },
  { href: "/library", label: "Library", icon: I.Library, match: ["/library", "/file", "/opds"] },
  { href: "/search", label: "Search", icon: I.Search, match: ["/search"] },
];

const RAIL_EXTRA = [
  { href: "/arcs", label: "Arcs & events", icon: I.Spark, match: ["/arcs", "/arc"] },
  { href: "/characters", label: "Characters", icon: I.Users, match: ["/characters", "/character"] },
  { href: "/teams", label: "Teams", icon: I.Shield, match: ["/teams", "/team"] },
];

const RAIL_FOOT = [
  { href: "/curate", label: "Curate", icon: I.Wrench, match: ["/curate"] },
  { href: "/settings", label: "Settings", icon: I.Gear, match: ["/settings"] },
];

function isActive(pathname: string, match: string[]) {
  const p = pathname.replace(/\/$/, "") || "/";
  return match.some((m) => (m === "/" ? p === "/" : p === m || p.startsWith(`${m}/`)));
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const immersive = pathname.startsWith("/read");

  useEffect(() => {
    const native = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
    if (native) {
      // Android back button: step back through the app, then Home, and only leave the app from Home.
      // The WebView's canGoBack misses history entries created without a user gesture, so check ours too.
      let remove: (() => void) | undefined;
      import("@capacitor/app").then(({ App }) => App.addListener("backButton", ({ canGoBack }) => {
        const atHome = (window.location.pathname.replace(/\/$/, "") || "/") === "/";
        if (canGoBack || (window.history.length > 1 && !atHome)) window.history.back();
        else if (!atHome) window.location.assign("/");
        else App.exitApp();
      })).then((h) => { remove = () => h.remove(); }).catch(() => {});
      return () => remove?.();
    }
    // Offline app shell for the installable web app (the Android app bundles its own files)
    if ("serviceWorker" in navigator && location.protocol !== "file:" && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  if (immersive) return <ToastProvider>{children}</ToastProvider>;

  const nav = (items: typeof TABS) => items.map(({ href, label, icon: Icon, match }) => (
    <Link key={href} href={href} className="navlink" aria-current={isActive(pathname, match) ? "page" : undefined}>
      <Icon /><span>{label}</span>
    </Link>
  ));

  return (
    <ToastProvider>
      <div className="shell">
        <a href="#content" className="visually-hidden">Skip to content</a>
        <header className="topbar">
          <Link href="/" className="wordmark" aria-label="ComixCenter home"><I.RegMark size={24} />ComixCenter</Link>
          <span className="spacer" />
          <Link href="/curate" className="btn ghost" aria-label="Curate"><I.Wrench /></Link>
          <Link href="/settings" className="btn ghost" aria-label="Settings"><I.Gear /></Link>
        </header>
        <nav className="rail" aria-label="Main">
          <Link href="/" className="wordmark"><I.RegMark size={28} />ComixCenter</Link>
          {nav(TABS)}
          <div className="railsep" />
          {nav(RAIL_EXTRA)}
          <div style={{ flex: 1 }} />
          {nav(RAIL_FOOT)}
        </nav>
        <main className="main" id="content">{children}</main>
        <nav className="tabbar" aria-label="Main">
          {TABS.map(({ href, label, icon: Icon, match }) => (
            <Link key={href} href={href} className="tab" aria-current={isActive(pathname, match) ? "page" : undefined}>
              <Icon /><span>{label}</span>
            </Link>
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}
