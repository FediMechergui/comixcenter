"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import type { PathName, Tier } from "@/lib/types";

export const TIER_LABEL: Record<Tier, string> = {
  essential: "Essential", recommended: "Recommended", tie_in: "Tie-in", optional: "Optional", skip: "Skip",
};
export const TIERS: Tier[] = ["essential", "recommended", "tie_in", "optional", "skip"];

export const PATHS: { value: PathName; label: string; hint: string }[] = [
  { value: "essential", label: "Essential", hint: "Only the must-reads" },
  { value: "core", label: "Core", hint: "Essential + Recommended" },
  { value: "complete", label: "Complete", hint: "Everything except Skip" },
  { value: "all", label: "Everything", hint: "Including Skip" },
];

export function TierChip({ tier }: { tier: Tier }) {
  return <span className={`tier tier-${tier}`}>{TIER_LABEL[tier]}</span>;
}

export function ProgressBar({ read, total, thin, label }: { read: number; total: number; thin?: boolean; label?: string }) {
  const pct = total > 0 ? Math.round((read / total) * 100) : 0;
  return (
    <div className={`progress${thin ? " thin" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={total}
         aria-valuenow={read} aria-label={label ?? `${read} of ${total} read`}>
      <span style={{ width: `${pct}%`, borderRightWidth: pct === 0 || pct === 100 ? 0 : undefined }} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.hint} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, action, children, id }: { title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <div className="section-head"><h2 className="h2" id={id ? `${id}-h` : undefined}>{title}</h2>{action}</div>
      {children}
    </section>
  );
}

export function Crumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          {i > 0 && <span aria-hidden>/</span>}
          {it.href ? <Link href={it.href}>{it.label}</Link> : <span>{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function PageHead({ eyebrow, title, crumbs, children }: { eyebrow?: string; title: string; crumbs?: { href?: string; label: string }[]; children?: ReactNode }) {
  return (
    <header className="pagehead">
      {crumbs && <Crumbs items={crumbs} />}
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h1 className="title">{title}</h1>
      {children}
    </header>
  );
}

export function Facts({ items }: { items: [string | number | null | undefined, string][] }) {
  return (
    <div className="facts">
      {items.filter(([v]) => v !== null && v !== undefined && v !== "").map(([v, l]) => (
        <div className="fact" key={l}><b>{v}</b><span>{l}</span></div>
      ))}
    </div>
  );
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ height: 44, width: "60%" }} />
      {Array.from({ length: lines }).map((_, i) => <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const err = error as ApiError | Error;
  const offline = err instanceof ApiError && err.status === 0;
  return (
    <div className="notice error" role="alert">
      <strong>{offline ? "Server not reachable" : err instanceof ApiError && err.status === 404 ? "Not found" : "Something went wrong"}</strong>
      <p className="small" style={{ margin: "6px 0 10px" }}>{err?.message}</p>
      <div className="row">
        {retry && <button className="btn small" onClick={retry}>Try again</button>}
        {offline && <Link className="btn small secondary" href="/settings">Server settings</Link>}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong style={{ color: "var(--ink)" }}>{title}</strong>
      {children && <div className="small" style={{ maxWidth: 460 }}>{children}</div>}
      {action}
    </div>
  );
}

export function formatDate(iso: string | null | undefined, style: "month" | "year" | "full" = "month"): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "";
  if (style === "year") return String(d.getFullYear());
  return d.toLocaleDateString(undefined, style === "full" ? { year: "numeric", month: "short", day: "numeric" } : { year: "numeric", month: "short" });
}

export function plural(n: number, one: string, many = `${one}s`) { return `${n.toLocaleString()} ${n === 1 ? one : many}`; }

// ── Toasts ──
const ToastCtx = createContext<(msg: string) => void>(() => {});
export function useToast() { return useContext(ToastCtx); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  const show = useCallback((m: string) => setMsg(m), []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </ToastCtx.Provider>
  );
}

/** Wraps an async action: shows a toast on success or the error message on failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, done?: string | ((r: T) => string)) => {
    setBusy(true);
    try {
      const r = await fn();
      if (done) toast(typeof done === "function" ? done(r) : done);
      return r;
    } catch (e) {
      toast((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

// ── Curate mode (shows editing tools on catalog pages) ──
const CURATE_KEY = "comix.curate";
export function useCurateMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => { try { setOn(localStorage.getItem(CURATE_KEY) === "1"); } catch { /* ignore */ } }, []);
  const set = useCallback((v: boolean) => {
    setOn(v);
    try { if (v) localStorage.setItem(CURATE_KEY, "1"); else localStorage.removeItem(CURATE_KEY); } catch { /* ignore */ }
  }, []);
  return [on, set];
}
