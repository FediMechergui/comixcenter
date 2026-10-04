"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import * as I from "@/components/icons";
import { Loading, plural, Section, useAction } from "@/components/ui";
import { api, dataMode, qs, refresh, useApi } from "@/lib/api";

interface GcdHit { gcd_id: number; name: string; year_began: number | null; year_end: number | null; issue_count: number; country: string | null; language: string | null; in_catalog: boolean; local_id: number | null }
interface MetronHit { metron_id: number; name: string; year_began?: number; issue_count?: number; publisher?: string | null; series_type?: string | null }
interface OnlineResults { gcd: GcdHit[]; metron: Record<string, MetronHit[]>; errors: string[] }

const KIND_LABEL: Record<string, string> = { series: "Series", arc: "Arcs & events", character: "Characters", team: "Teams", reading_list: "Reading lists" };
const PATH: Record<string, string> = { series: "/series", arc: "/arc", character: "/character", team: "/team", order: "/order" };

/**
 * Finds comics online (Grand Comics Database for every publisher; Metron for arcs, characters
 * and teams when connected) and adds the one you pick to the catalog on your phone.
 */
export function OnlineResults({ q, year }: { q: string; year?: number | null }) {
  const router = useRouter();
  const { run } = useAction();
  const [adding, setAdding] = useState<string | null>(null);
  const kinds = "series,arc,character,team,reading_list";
  const { data, error, isLoading } = useApi<OnlineResults>(q && dataMode() === "device" ? `/api/online/search${qs({ q, year, kinds })}` : null);
  if (dataMode() !== "device" || !q) return null;

  const add = (source: "gcd" | "metron", kind: string, id: number, label: string) => {
    const key = `${source}-${kind}-${id}`;
    setAdding(key);
    run(() => api.post<{ local: { kind: string; id: number } | null }>("/api/online/add", { source, kind, id }), `Added ${label}`)
      .then((r) => {
        setAdding(null);
        refresh("/api/");
        if (r?.local) router.push(`${PATH[r.local.kind]}?id=${r.local.id}`);
      });
  };

  return (
    <Section title="Find online">
      {isLoading && <Loading lines={2} />}
      {error && <p className="small" style={{ color: "var(--danger)" }}>{(error as Error).message}</p>}
      {data?.errors.map((e) => <p key={e} className="small" role="alert" style={{ color: "var(--danger)", margin: 0 }}>{e}</p>)}
      {data && (
        <div className="stack">
          {data.gcd.length > 0 && (
            <>
              <span className="eyebrow">Series · Grand Comics Database (every publisher)</span>
              <div className="list">
                {data.gcd.map((s) => {
                  const key = `gcd-series-${s.gcd_id}`;
                  const years = s.year_began ? `${s.year_began}${s.year_end && s.year_end !== s.year_began ? `–${s.year_end}` : s.year_end ? "" : "–"}` : "";
                  return (
                    <div key={key} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                      <span className="body"><strong>{s.name}</strong>
                        <span className="mono">{[years, plural(s.issue_count, "issue"), s.country?.toUpperCase(), s.language].filter(Boolean).join(" · ")}</span></span>
                      <button className={`btn small ${s.in_catalog ? "secondary" : ""}`} disabled={adding !== null}
                        onClick={() => s.local_id ? router.push(`/series?id=${s.local_id}`) : add("gcd", "series", s.gcd_id, s.name)}>
                        {adding === key ? "Adding…" : s.in_catalog ? <>Open</> : <><I.Plus />Add</>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {Object.entries(data.metron).filter(([, rows]) => rows.length).map(([kind, rows]) => (
            <div key={kind} className="stack" style={{ gap: 6 }}>
              <span className="eyebrow">{KIND_LABEL[kind] ?? kind} · Metron</span>
              <div className="list">
                {rows.map((r) => {
                  const key = `metron-${kind}-${r.metron_id}`;
                  return (
                    <div key={key} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                      <span className="body"><strong>{r.name}</strong>
                        <span className="mono">{[r.publisher, r.series_type, r.issue_count ? plural(r.issue_count, "issue") : null].filter(Boolean).join(" · ")}</span></span>
                      <button className="btn small" disabled={adding !== null} onClick={() => add("metron", kind, r.metron_id, r.name)}>
                        {adding === key ? "Adding…" : <><I.Plus />Add</>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {data.gcd.length === 0 && !data.errors.length && !Object.values(data.metron).some((r) => r.length) && <p className="muted">Nothing online called &ldquo;{q}&rdquo;.</p>}
          {!Object.keys(data.metron).length && (
            <p className="small muted" style={{ margin: 0 }}>
              Story arcs, characters and teams come from Metron. <Link href="/settings" style={{ color: "var(--cyan-ink)", fontWeight: 700 }}>Add your Metron account</Link> to search them.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
