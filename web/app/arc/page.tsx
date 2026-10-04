"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArcRow, IssueTile, Thumb } from "@/components/cards";
import * as I from "@/components/icons";
import { useNumberParam, withParams } from "@/components/params";
import { Picker } from "@/components/pickers";
import { ErrorBox, Facts, formatDate, Loading, PageHead, plural, ProgressBar, Section, TIER_LABEL, TIERS, useAction, useCurateMode } from "@/components/ui";
import { api, refresh, useApi } from "@/lib/api";
import type { ArcDetail, ArcIssueCard, OrderCard, Plan, Tier } from "@/lib/types";

function ArcPage() {
  const id = useNumberParam("id");
  const key = id ? `/api/arcs/${id}` : null;
  const { data: a, error, mutate } = useApi<ArcDetail>(key);
  const plan = useApi<Plan>(id ? `/api/arcs/${id}/plan` : null);
  const { run, busy } = useAction();
  const [curate] = useCurateMode();
  const router = useRouter();
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!a) return <Loading lines={6} />;
  const allRead = a.issue_count > 0 && a.read_count >= a.issue_count;
  const reload = () => { mutate(); plan.mutate(); refresh("/api/progress", "/api/orders"); };

  return (
    <>
      <PageHead eyebrow={a.kind === "event" ? "Event" : "Story arc"} title={a.name}
        crumbs={[{ href: "/arcs", label: "Arcs & events" }, { label: a.name }]}>
        <Facts items={[[a.issue_count, "Issues"], [a.tie_ins.length || null, "Tie-ins"], [formatDate(a.start_date), "Began"], [formatDate(a.end_date), "Ended"]]} />
        {a.issue_count > 0 && <ProgressBar read={a.read_count} total={a.issue_count} />}
        <div className="row">
          <button className="btn secondary small" disabled={busy} onClick={() => run(() => api.put(`/api/arcs/${a.id}/read`, { read: !allRead }), allRead ? "Marked unread" : "Marked read").then(reload)}>
            <I.Check />{allRead ? "Mark unread" : "Mark all read"}
          </button>
          {curate && (
            <button className="btn secondary small" disabled={busy}
              onClick={() => run(() => api.post<OrderCard>("/api/admin/orders/generate", { source: "event", id: a.id }), "Reading order drafted")
                .then((o) => o && router.push(`/order?id=${o.id}`))}>
              <I.Path />Draft a reading order
            </button>
          )}
        </div>
      </PageHead>

      <div className="stack-lg">
        {a.description && <Section title="Synopsis"><p className="prose" style={{ margin: 0 }}>{a.description}</p></Section>}

        {plan.data && plan.data.sequence.length > 0 && <PlanView plan={plan.data} />}

        <Section title={a.kind === "event" ? "Core issues" : "Issues"}>
          <IssueGrid issues={a.core_issues} arcId={a.id} curate={curate} onChange={reload} />
        </Section>
        {a.tie_ins.length > 0 && (
          <Section title="Tie-ins">
            <p className="small muted" style={{ margin: 0 }}>Ranked by how much they matter to the main story.</p>
            <IssueGrid issues={[...a.tie_ins].sort((x, y) => TIERS.indexOf(x.tier ?? "tie_in") - TIERS.indexOf(y.tier ?? "tie_in"))} arcId={a.id} curate={curate} onChange={reload} />
          </Section>
        )}

        {(a.leads_into.length > 0 || a.continues_in.length > 0) && (
          <Section title="What happens next">
            <div className="list">
              {a.leads_into.map((x) => <ArcRow key={`l${x.id}`} a={x} note={x.note ?? "Leads into"} />)}
              {a.continues_in.filter((x) => !a.leads_into.some((l) => l.id === x.id)).map((x) => <ArcRow key={`c${x.id}`} a={x} note="Next in the same series" />)}
            </div>
          </Section>
        )}
        {a.follows.length > 0 && <Section title="Follows"><div className="list">{a.follows.map((x) => <ArcRow key={x.id} a={x} note={x.note} />)}</div></Section>}
        {a.required_by.length > 0 && <Section title="Read this before"><div className="list">{a.required_by.map((x) => <ArcRow key={x.id} a={x} note={x.note} />)}</div></Section>}

        {a.collected_editions.length > 0 && (
          <Section title="Collected editions">
            <div className="list">
              {a.collected_editions.map((c) => (
                <Link key={c.issue_id} href={`/issue?id=${c.issue_id}`} className="list-row">
                  <Thumb src={c.image_url} />
                  <span className="body"><strong>{c.title}</strong><span className="mono">{c.series_type ?? "Collection"}</span></span>
                  <span className="mono">{c.covers} of {c.of} issues</span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        {a.creators.length > 0 && (
          <Section title="Creators">
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 18px", margin: 0 }}>
              {a.creators.slice(0, 6).map((c) => (
                <div key={c.role} style={{ display: "contents" }}>
                  <dt className="eyebrow" style={{ paddingTop: 3 }}>{c.role}</dt>
                  <dd style={{ margin: 0 }}>{c.creators.map((p, i) => <span key={p.id}>{i > 0 && ", "}<Link href={`/creator?id=${p.id}`} style={{ fontWeight: 600 }}>{p.name}</Link></span>)}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {a.reading_orders.length > 0 && (
          <Section title="In reading orders">
            <div className="row">{a.reading_orders.map((o) => <Link key={o.id} className="chip" href={`/order?id=${o.id}`}>{o.name}</Link>)}</div>
          </Section>
        )}

        {curate && <ArcCurator arc={a} onChange={reload} />}
      </div>
    </>
  );
}

function IssueGrid({ issues, arcId, curate, onChange }: { issues: ArcIssueCard[]; arcId: number; curate: boolean; onChange: () => void }) {
  const { run } = useAction();
  return (
    <div className="grid-covers">
      {issues.map((i) => (
        <div key={i.id} className="stack" style={{ gap: 6 }}>
          <IssueTile issue={i} tier={i.role === "tie_in" ? (i.tier ?? "tie_in") : undefined} />
          {curate && (
            <div className="stack" style={{ gap: 4 }}>
              <label className="visually-hidden" htmlFor={`role-${i.id}`}>Role</label>
              <select id={`role-${i.id}`} className="select" value={i.role === "core" ? "core" : i.tier ?? "tie_in"}
                onChange={(e) => {
                  const v = e.target.value;
                  run(() => api.post(`/api/admin/arcs/${arcId}/issues`, v === "core" ? { issue_id: i.id, role: "core" } : { issue_id: i.id, role: "tie_in", tier: v }), "Saved").then(onChange);
                }}>
                <option value="core">Core issue</option>
                {TIERS.map((t) => <option key={t} value={t}>Tie-in: {TIER_LABEL[t]}</option>)}
              </select>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** "What do I need before this?" — prerequisites in a valid reading sequence. */
function PlanView({ plan }: { plan: Plan }) {
  const maxDepth = Math.max(...plan.sequence.map((s) => s.depth));
  return (
    <Section title="Read first">
      <p className="small" style={{ margin: 0 }}>
        {plan.remaining_arcs === 0
          ? "You've read everything this story builds on."
          : <>Before <strong>{plan.target.name}</strong>: {plural(plan.remaining_arcs, "arc")} left, {plural(plan.remaining_issues, "issue")}.</>}
      </p>
      <ol className="list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {plan.sequence.map((s, idx) => {
          const note = plan.edges.find((e) => e.to === s.id)?.note;
          return (
            <li key={s.id} style={{ display: "grid", gridTemplateColumns: "34px 1fr", alignItems: "stretch" }}>
              <span aria-hidden style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <span style={{ width: 2, flex: 1, background: idx === 0 ? "transparent" : "var(--ink)" }} />
                <span style={{ width: 22, height: 22, borderRadius: "50%", border: "2px solid var(--ink)", background: s.done ? "var(--yellow)" : "var(--card)",
                  display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: "0.65rem", fontWeight: 700 }}>
                  {s.done ? "✓" : maxDepth - s.depth + 1}
                </span>
                <span style={{ width: 2, flex: 1, background: "var(--ink)" }} />
              </span>
              <ArcRow a={s} note={note} />
            </li>
          );
        })}
        <li style={{ display: "grid", gridTemplateColumns: "34px 1fr", alignItems: "center" }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center" }}>
            <span style={{ width: 22, height: 22, background: "var(--ink)", borderRadius: 3 }} />
          </span>
          <strong style={{ padding: "12px 4px" }}>{plan.target.name}</strong>
        </li>
      </ol>
    </Section>
  );
}

function ArcCurator({ arc, onChange }: { arc: ArcDetail; onChange: () => void }) {
  const { run, busy } = useAction();
  const [kind, setKind] = useState<"prerequisite" | "leads_into">("prerequisite");
  const [note, setNote] = useState("");
  const [addIssueRole, setAddIssueRole] = useState<"core" | Tier>("core");
  return (
    <Section title="Curate this arc">
      <div className="row">
        <span className="small">Kind:</span>
        <button className="btn secondary small" disabled={busy}
          onClick={() => run(() => api.patch(`/api/admin/arcs/${arc.id}`, { kind: arc.kind === "event" ? "arc" : "event" }), "Saved").then(onChange)}>
          Make it {arc.kind === "event" ? "a story arc" : "an event"}
        </button>
      </div>
      <div className="card flat stack">
        <strong>Link another arc</strong>
        <div className="row">
          <select className="select" style={{ maxWidth: 230 }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Link type">
            <option value="prerequisite">Must be read before this</option>
            <option value="leads_into">This leads into</option>
          </select>
          <input className="input" style={{ maxWidth: 280 }} placeholder="Why (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        </div>
        <Picker kind="arc" label="Find an arc" onPick={(o) => run(() => api.post(`/api/admin/arcs/${arc.id}/links`, { target_arc_id: o.id, kind, note: note || null }),
          `Linked ${o.label}`).then(() => { setNote(""); onChange(); })} />
        {[...arc.prerequisites.map((p) => ({ ...p, label: "Read before" })), ...arc.leads_into.map((p) => ({ ...p, label: "Leads into" }))].map((l) => (
          <div key={l.link_id} className="between small">
            <span><span className="eyebrow">{l.label}</span> {l.name} <span className="mono">({l.source})</span></span>
            <button className="btn ghost small" onClick={() => run(() => api.del(`/api/admin/arc-links/${l.link_id}`), "Link removed").then(onChange)}><I.X />Remove</button>
          </div>
        ))}
      </div>
      <div className="card flat stack">
        <strong>Add an issue to this {arc.kind}</strong>
        <div className="row">
          <select className="select" style={{ maxWidth: 230 }} value={addIssueRole} onChange={(e) => setAddIssueRole(e.target.value as typeof addIssueRole)} aria-label="Role">
            <option value="core">As a core issue</option>
            {TIERS.map((t) => <option key={t} value={t}>As a tie-in: {TIER_LABEL[t]}</option>)}
          </select>
        </div>
        <Picker kind="issue" label="Find an issue" onPick={(o) => run(() => api.post(`/api/admin/arcs/${arc.id}/issues`,
          addIssueRole === "core" ? { issue_id: o.id, role: "core" } : { issue_id: o.id, role: "tie_in", tier: addIssueRole }), `Added ${o.label}`).then(onChange)} />
      </div>
    </Section>
  );
}

export default withParams(ArcPage);
