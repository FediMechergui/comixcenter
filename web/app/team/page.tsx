"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { IssueTile, Pager } from "@/components/cards";
import * as I from "@/components/icons";
import { useNumberParam, withParams } from "@/components/params";
import { Picker } from "@/components/pickers";
import { ErrorBox, Facts, formatDate, Loading, PageHead, plural, Section, useAction, useCurateMode } from "@/components/ui";
import { api, qs, useApi } from "@/lib/api";
import type { IssueCard, OrderCard, Page, RosterRow, TeamDetail } from "@/lib/types";

function TeamPage() {
  const id = useNumberParam("id");
  const { data: t, error, mutate } = useApi<TeamDetail>(id ? `/api/teams/${id}` : null);
  const [page, setPage] = useState(1);
  const issues = useApi<Page<IssueCard>>(id ? `/api/teams/${id}/issues${qs({ page, size: 24 })}` : null, { keepPreviousData: true });
  const [curate] = useCurateMode();
  const { run, busy } = useAction();
  const router = useRouter();
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!t) return <Loading lines={6} />;
  return (
    <>
      <PageHead eyebrow="Team" title={t.name} crumbs={[{ href: "/teams", label: "Teams" }, { label: t.name }]}>
        <Facts items={[[t.appearances, "Appearances"], [t.members.length || null, "Known members"], [formatDate(t.first_seen, "year"), "Since"]]} />
        {t.first_appearance && <span className="small"><span className="tier tier-essential">First appearance</span>{" "}
          {t.first_appearance.id ? <Link href={`/issue?id=${t.first_appearance.id}`} style={{ fontWeight: 700 }}>{t.first_appearance.label}</Link> : t.first_appearance.label}</span>}
        {t.disbanded && <span className="small"><span className="tier tier-tie_in">Disbanded</span> {t.disbanded}</span>}
        {curate && (
          <div className="row">
            <button className="btn secondary small" disabled={busy} onClick={() => run(() => api.post(`/api/admin/teams/${t.id}/derive`), "Roster rebuilt from appearances").then(() => mutate())}><I.Refresh />Rebuild roster dates</button>
            <button className="btn secondary small" disabled={busy}
              onClick={() => run(() => api.post<OrderCard>("/api/admin/orders/generate", { source: "team", id: t.id }), "Reading order drafted").then((o) => o && router.push(`/order?id=${o.id}`))}>
              <I.Path />Draft a reading order
            </button>
          </div>
        )}
      </PageHead>

      <div className="stack-lg">
        {t.description && <p className="prose" style={{ margin: 0 }}>{t.description}</p>}
        <Section title="Roster over time">
          {t.roster.length === 0
            ? <p className="muted">No roster yet. Members come from Metron and Comic Vine; dates come from the issues they share with the team.</p>
            : <RosterTimeline rows={t.roster} />}
        </Section>

        {t.linked_teams.length > 0 && (
          <Section title="Linked teams">
            <div className="list">
              {t.linked_teams.map((l) => (
                <Link key={l.team_id} href={`/team?id=${l.team_id}`} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                  <span className="body"><strong>{l.name}</strong>
                    <span className="mono">{l.kinds.filter((k) => k !== "shared_members").join(", ")}{l.note ? ` · ${l.note}` : ""}</span></span>
                  {l.shared_members > 0 && <span className="mono">{plural(l.shared_members, "shared member")}</span>}
                </Link>
              ))}
            </div>
          </Section>
        )}

        {t.reading_orders.length > 0 && (
          <Section title="Reading orders"><div className="row">{t.reading_orders.map((o) => <Link key={o.id} className="chip" href={`/order?id=${o.id}`}>{o.name}</Link>)}</div></Section>
        )}

        {curate && <TeamCurator team={t} onChange={() => mutate()} />}

        <Section title="Appearances">
          {!issues.data ? <Loading /> : (
            <>
              <div className="grid-covers">{issues.data.items.map((i) => <IssueTile key={i.id} issue={i} />)}</div>
              <Pager page={issues.data.page} size={issues.data.size} total={issues.data.total} onPage={setPage} />
            </>
          )}
        </Section>
      </div>
    </>
  );
}

/** Swimlane roster: one lane per member, a bar from first to last issue with the team. */
function RosterTimeline({ rows }: { rows: RosterRow[] }) {
  const dated = rows.filter((r) => r.from_date);
  const undated = rows.filter((r) => !r.from_date);
  const { min, max } = useMemo(() => {
    const years = dated.flatMap((r) => [new Date(r.from_date!).getFullYear(), new Date(r.to_date ?? r.from_date!).getFullYear()]);
    return { min: Math.min(...years), max: Math.max(...years) + 1 };
  }, [dated]);
  const span = Math.max(1, max - min);
  const x = (iso: string) => {
    const d = new Date(iso);
    return ((d.getFullYear() + d.getMonth() / 12 - min) / span) * 100;
  };
  const ticks = Array.from({ length: Math.min(span, 8) + 1 }, (_, i) => Math.round(min + (span * i) / Math.min(span, 8)));
  return (
    <div className="stack" style={{ gap: 4 }}>
      {dated.length > 0 && (
        <div role="table" aria-label="Membership timeline" style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 300 }}>
            <div role="row" style={{ display: "grid", gridTemplateColumns: "minmax(88px, 150px) 1fr", alignItems: "end" }}>
              <span role="columnheader" className="eyebrow">Member</span>
              <div role="columnheader" style={{ position: "relative", height: 18 }}>
                {ticks.map((y) => <span key={y} className="mono" style={{ position: "absolute", left: `${((y - min) / span) * 100}%`, transform: "translateX(-50%)", fontSize: "0.68rem" }}>{y}</span>)}
              </div>
            </div>
            {dated.map((r) => {
              const left = x(r.from_date!);
              const width = Math.max(1.2, x(r.to_date ?? r.from_date!) - left);
              return (
                <div role="row" key={r.id} style={{ display: "grid", gridTemplateColumns: "minmax(88px, 150px) 1fr", alignItems: "center", borderTop: "1px solid var(--rule)", minHeight: 34 }}>
                  <Link role="rowheader" href={`/character?id=${r.character_id}`} className="small" style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>
                    {r.display_name}
                  </Link>
                  <div role="cell" style={{ position: "relative", height: 34 }}
                       aria-label={`${r.display_name}: ${r.from_label ?? ""} to ${r.to_label ?? "now"}`}>
                    {ticks.map((y) => <span key={y} aria-hidden style={{ position: "absolute", top: 0, bottom: 0, left: `${((y - min) / span) * 100}%`, borderLeft: "1px dashed var(--rule)" }} />)}
                    <span title={`${r.from_label} → ${r.to_label ?? "now"}`} style={{
                      position: "absolute", top: 10, height: 14, left: `${left}%`, width: `${width}%`, borderRadius: 3,
                      background: r.source === "curated" ? "var(--magenta)" : "var(--cyan)", border: "1.5px solid var(--ink)",
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="mono" style={{ margin: "6px 0 0" }}>
        <span style={{ display: "inline-block", width: 10, height: 10, background: "var(--cyan)", border: "1px solid var(--ink)", marginRight: 4 }} />from shared appearances
        <span style={{ display: "inline-block", width: 10, height: 10, background: "var(--magenta)", border: "1px solid var(--ink)", margin: "0 4px 0 14px" }} />curated
      </p>
      {undated.length > 0 && (
        <p className="small" style={{ margin: 0 }}><span className="muted">Members without dated appearances:</span>{" "}
          {undated.map((r, i) => <span key={r.id}>{i > 0 && ", "}<Link href={`/character?id=${r.character_id}`} style={{ fontWeight: 600 }}>{r.display_name}</Link></span>)}</p>
      )}
    </div>
  );
}

function TeamCurator({ team, onChange }: { team: TeamDetail; onChange: () => void }) {
  const { run } = useAction();
  const [linkKind, setLinkKind] = useState("spinoff");
  return (
    <Section title="Curate this team">
      <div className="card flat stack">
        <strong>Link a related team</strong>
        <div className="row">
          <select className="select" style={{ width: 180 }} value={linkKind} onChange={(e) => setLinkKind(e.target.value)} aria-label="Link type">
            <option value="spinoff">Spin-off</option><option value="successor">Successor</option><option value="related">Related</option>
          </select>
          <Picker kind="team" label="Find a team" onPick={(o) => run(() => api.post("/api/admin/team-links", { team_id: team.id, other_team_id: o.id, kind: linkKind }), `Linked ${o.label}`).then(onChange)} />
        </div>
      </div>
      {team.roster.length > 0 && (
        <details className="disclosure card flat">
          <summary>Edit membership stints</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            {team.roster.map((r) => (
              <div key={r.id} className="between small">
                <span><strong>{r.display_name}</strong> <span className="mono">{r.from_label ?? "?"} → {r.to_label ?? "now"} · {r.source}</span></span>
                <button className="btn ghost small" onClick={() => run(() => api.del(`/api/admin/memberships/${r.id}`), "Removed").then(onChange)}><I.X />Remove</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </Section>
  );
}

export default withParams(TeamPage);
