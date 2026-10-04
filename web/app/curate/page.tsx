"use client";
import Link from "next/link";
import { useState } from "react";
import * as I from "@/components/icons";
import { ErrorBox, formatDate, PageHead, plural, Section, Segmented, useAction, useCurateMode } from "@/components/ui";
import { api, dataMode, qs, refresh, useApi } from "@/lib/api";
import { OnlineResults } from "@/components/online";
import type { Job, Status } from "@/lib/types";

type Kind = "series" | "arc" | "character" | "team" | "reading_list";
interface Hit { metron_id: number; name: string; year_began?: number; issue_count?: number; publisher?: string; series_type?: string; in_catalog: boolean }

const JOB_LABEL: Record<string, string> = {
  "metron.series": "Series", "metron.issue": "Issue details", "metron.issue_by_cv": "First-appearance issue", "metron.arc": "Arc",
  "metron.character": "Character", "metron.team": "Team", "metron.reading_list": "Reading list", "metron.find_series": "Series lookup",
  "metron.publishers": "Publishers", "comicvine.identity": "Comic Vine: character", "comicvine.team": "Comic Vine: team",
  "comicvine.arc": "Comic Vine: arc", "comicvine.issue": "Comic Vine: issue", "teams.derive": "Roster dates", "library.rematch": "Library re-match",
};

export default function CuratePage() {
  const status = useApi<Status>("/api/status", { refreshInterval: 4000 });
  const [curate, setCurate] = useCurateMode();
  const s = status.data;
  return (
    <>
      <PageHead eyebrow="Admin" title="Curate">
        <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
          Bring comics into the catalog from Metron and Comic Vine, then shape them: tiers, prerequisites, rosters, universes.
        </p>
      </PageHead>
      <div className="stack-lg">
        {status.error && <ErrorBox error={status.error} retry={() => status.mutate()} />}
        <div className="card stack">
          <div className="between">
            <div className="stack" style={{ gap: 2 }}>
              <strong className="h3">Curate mode</strong>
              <span className="small muted">Shows editing tools on arc, order, character, team and series pages.</span>
            </div>
            <Segmented label="Curate mode" value={curate ? "on" : "off"} onChange={(v) => setCurate(v === "on")}
              options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]} />
          </div>
          {s && (
            <div className="row small">
              <span className={`tier ${s.sources.metron ? "tier-recommended" : "tier-skip"}`}>Metron {s.sources.metron ? "connected" : "not set up"}</span>
              <span className={`tier ${s.sources.comicvine ? "tier-recommended" : "tier-skip"}`}>Comic Vine {s.sources.comicvine ? "connected" : "not set up"}</span>
              <span className="mono">{s.worker.running ? "Sync worker running" : "Sync worker stopped"} · {plural(s.worker.queued, "job")} waiting</span>
            </div>
          )}
          {s && !s.sources.metron && (dataMode() === "device"
            ? <p className="small" style={{ margin: 0 }}>The Grand Comics Database works without an account. <Link href="/settings" style={{ color: "var(--cyan-ink)", fontWeight: 700 }}>Add Metron and Comic Vine</Link> for arcs, characters, teams and first appearances.</p>
            : <p className="small" style={{ margin: 0 }}>Add <code>METRON_API_TOKEN</code> (or <code>METRON_USERNAME</code> and <code>METRON_PASSWORD</code>) and <code>COMICVINE_API_KEY</code> to <code>backend/.env</code>, then restart the server.</p>)}
        </div>

        {dataMode() === "device" ? <FindOnline /> : <MetronSearch disabled={!s?.sources.metron} />}
        <StarterPack />
        <Jobs />
      </div>
    </>
  );
}

function FindOnline() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  return (
    <Section title="Add comics">
      <form className="row" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); }}>
        <label className="visually-hidden" htmlFor="fo">Name</label>
        <input id="fo" className="input" style={{ flex: 1, minWidth: 200 }} placeholder="A series, event, character or team" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn" disabled={!text.trim()}><I.Search />Search online</button>
      </form>
      {q && <OnlineResults q={q} />}
    </Section>
  );
}

function MetronSearch({ disabled }: { disabled: boolean }) {
  const [kind, setKind] = useState<Kind>("series");
  const [q, setQ] = useState("");
  const [year, setYear] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [deep, setDeep] = useState(true);
  const { run, busy } = useAction();
  const search = () => run(() => api.get<Hit[]>(`/api/admin/metron/search${qs({ kind, q, year: kind === "series" ? year : null })}`)).then((r) => r && setHits(r));
  return (
    <Section title="Add from Metron">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (q.trim()) search(); }}>
        <Segmented label="What to find" value={kind} onChange={(v) => { setKind(v); setHits(null); }} options={[
          { value: "series", label: "Series" }, { value: "arc", label: "Arcs & events" }, { value: "character", label: "Characters" },
          { value: "team", label: "Teams" }, { value: "reading_list", label: "Reading lists" }]} />
        <div className="row">
          <label className="visually-hidden" htmlFor="mq">Name</label>
          <input id="mq" className="input" style={{ flex: 1, minWidth: 200 }} placeholder={kind === "series" ? "e.g. Amazing Spider-Man" : kind === "arc" ? "e.g. Secret Wars" : "Name"} value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
          {kind === "series" && <input className="input" style={{ width: 110 }} inputMode="numeric" placeholder="Year" aria-label="Start year" value={year} onChange={(e) => setYear(e.target.value)} disabled={disabled} />}
          <button className="btn" disabled={disabled || busy || !q.trim()}><I.Search />Search Metron</button>
        </div>
        {(kind === "series" || kind === "arc") && (
          <label className="small" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} style={{ marginTop: 4 }} />
            <span>Fetch every issue&rsquo;s full record (credits, characters, arcs). Slower: Metron allows about 20 requests a minute.</span>
          </label>
        )}
      </form>
      {hits && hits.length === 0 && <p className="muted">Metron has nothing called &ldquo;{q}&rdquo;.</p>}
      {hits && hits.length > 0 && (
        <div className="list">
          {hits.map((h) => (
            <div key={h.metron_id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="body"><strong>{h.name}</strong>
                <span className="mono">{[h.publisher, h.series_type, h.issue_count ? plural(h.issue_count, "issue") : null, `Metron #${h.metron_id}`].filter(Boolean).join(" · ")}</span></span>
              <button className={`btn small ${h.in_catalog ? "secondary" : ""}`} disabled={busy}
                onClick={() => run(() => api.post("/api/admin/sync", { kind, metron_id: h.metron_id, deep, with_issues: true }),
                  h.in_catalog ? `Refreshing ${h.name}` : `Adding ${h.name}. It appears as the sync runs.`).then(() => refresh("/api/admin/jobs", "/api/status"))}>
                {h.in_catalog ? <><I.Refresh />Refresh</> : <><I.Plus />Add</>}
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function StarterPack() {
  const arcs = useApi<{ name: string; year: number }[]>("/api/admin/starter-pack/arcs");
  const { run, busy } = useAction();
  const [result, setResult] = useState<{ added: number; unresolved: { from: string; to: string; missing: string[] }[] } | null>(null);
  return (
    <Section title="Starter prerequisites">
      <p className="small muted" style={{ margin: 0, maxWidth: "70ch" }}>
        A small hand-made set of &ldquo;read before&rdquo; links between famous events (Civil War → Secret Invasion → Dark Reign → Siege, Sinestro Corps War → Blackest Night, and more).
        Links only attach to arcs already in your catalog, so add those events from Metron first.
      </p>
      <div className="row">
        <button className="btn secondary" disabled={busy} onClick={() => run(() => api.post<typeof result>("/api/admin/starter-pack"), (r) => `Added ${plural(r!.added, "link")}`).then((r) => r && setResult(r))}>
          <I.Link />Apply starter links
        </button>
        {arcs.data && <details className="disclosure small"><summary>Arcs it covers ({arcs.data.length})</summary>
          <p style={{ margin: "6px 0 0" }}>{arcs.data.map((a) => `${a.name} (${a.year})`).join(" · ")}</p></details>}
      </div>
      {result && result.unresolved.length > 0 && (
        <p className="small" style={{ margin: 0 }}><span className="muted">Not in your catalog yet:</span>{" "}
          {Array.from(new Set(result.unresolved.flatMap((u) => u.missing))).join(", ")}</p>
      )}
    </Section>
  );
}

function Jobs() {
  const [filter, setFilter] = useState<"all" | "queued" | "failed" | "done">("all");
  const { data, error, mutate } = useApi<{ counts: Record<string, number>; jobs: Job[] }>(`/api/admin/jobs${qs({ status: filter === "all" ? null : filter, limit: 60 })}`, { refreshInterval: 3000 });
  const { run } = useAction();
  return (
    <Section title="Sync queue" action={data && data.counts.done > 0 ? <button className="btn ghost small" onClick={() => run(() => api.del("/api/admin/jobs?status=done"), "Cleared finished jobs").then(() => mutate())}>Clear finished</button> : undefined}>
      <Segmented label="Show jobs" value={filter} onChange={setFilter} options={[
        { value: "all", label: "All" }, { value: "queued", label: `Waiting ${data?.counts.queued ?? ""}` },
        { value: "failed", label: `Failed ${data?.counts.failed ?? ""}` }, { value: "done", label: "Done" }]} />
      {error && <ErrorBox error={error} />}
      {data && data.jobs.length === 0 && <p className="muted">No jobs{filter !== "all" ? " here" : " yet"}.</p>}
      {data && data.jobs.length > 0 && (
        <div className="list">
          {data.jobs.map((j) => (
            <div key={j.id} className="list-row" style={{ gridTemplateColumns: "92px 1fr auto" }}>
              <span className={`tier ${j.status === "done" ? "tier-recommended" : j.status === "failed" ? "tier-tie_in" : j.status === "running" ? "tier-essential" : "tier-optional"}`}>{j.status}</span>
              <span className="body">
                <strong>{JOB_LABEL[j.kind] ?? j.kind}{j.progress ? `: ${j.progress}` : ""}</strong>
                <span className="mono">{j.run_after && j.status === "queued" ? `Waiting for the rate limit until ${formatDate(j.run_after, "full")} ` : ""}
                  {formatDate(j.created_at, "full")}{j.attempts > 1 ? ` · attempt ${j.attempts}` : ""}</span>
                {j.error && <span className="small" style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}>{j.error.split("\n")[0]}</span>}
              </span>
              {j.status === "failed" && <button className="btn ghost small" onClick={() => run(() => api.post(`/api/admin/jobs/${j.id}/retry`), "Queued again").then(() => mutate())}>Retry</button>}
            </div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>Finished syncs show up in <Link href="/browse" style={{ color: "var(--cyan-ink)" }}>Browse</Link> right away.</p>
    </Section>
  );
}
