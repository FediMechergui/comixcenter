"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CornerBox, Cover } from "@/components/cards";
import * as I from "@/components/icons";
import { useNumberParam, useSetParams, useStringParam, withParams } from "@/components/params";
import { Picker } from "@/components/pickers";
import { ErrorBox, Loading, PageHead, PATHS, plural, ProgressBar, Segmented, TIER_LABEL, TierChip, TIERS, useAction, useCurateMode } from "@/components/ui";
import { api, refresh, useApi } from "@/lib/api";
import type { OrderDetail, OrderEntry, PathName, Tier } from "@/lib/types";

function OrderPage() {
  const id = useNumberParam("id");
  const path = (useStringParam("path") as PathName) || "core";
  const setParams = useSetParams();
  const [curate] = useCurateMode();
  const editing = curate;
  const key = id ? `/api/orders/${id}?path=${editing ? "all" : path}` : null;
  const { data: o, error, mutate } = useApi<OrderDetail>(key, { keepPreviousData: true });
  const { run, busy } = useAction();
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!o) return <Loading lines={8} />;
  const prog = o.progress.paths[editing ? "all" : path];
  const reload = () => { mutate(); refresh("/api/progress", "/api/orders"); };

  return (
    <>
      <PageHead eyebrow={`${o.kind === "custom" ? "Reading order" : `${o.kind} reading order`}${o.source === "generated" ? " · draft" : ""}`} title={o.name}
        crumbs={[{ href: "/orders", label: "Reading orders" }, { label: o.name }]}>
        {o.description && <p className="prose muted" style={{ margin: 0 }}>{o.description}</p>}
      </PageHead>

      <div className="stack-lg">
        {!editing && (
          <div className="card stack">
            <div className="between">
              <Segmented label="Reading path" value={path} options={PATHS} onChange={(v) => setParams({ path: v === "core" ? null : v })} />
              <span className="mono">{PATHS.find((p) => p.value === path)?.hint}</span>
            </div>
            <div className="row" style={{ gap: 16 }}>
              {PATHS.map((p) => (
                <span key={p.value} className="mono" style={{ fontWeight: p.value === path ? 700 : 400, color: p.value === path ? "var(--ink)" : undefined }}>
                  {p.label}: {plural(o.progress.paths[p.value].issues, "issue")}
                </span>
              ))}
            </div>
            <ProgressBar read={prog.read} total={prog.issues} />
            <span className="small">{prog.read >= prog.issues && prog.issues > 0 ? "You've finished this path." : `${prog.read} of ${plural(prog.issues, "issue")} read on this path.`}</span>
          </div>
        )}

        {editing && <OrderEditorHead order={o} onChange={reload} />}

        {o.entries.length === 0 ? (
          <p className="muted">{editing ? "No entries yet. Add issues or arcs below." : "Nothing on this path. Try a longer path."}</p>
        ) : (
          <ol className="stack" style={{ margin: 0, padding: 0, listStyle: "none", gap: 10 }}>
            {o.entries.map((e, idx) => (
              <EntryRow key={e.id} entry={e} index={idx} count={o.entries.length} isNext={e.id === o.next_entry_id}
                editing={editing} busy={busy}
                onReadThrough={() => run(() => api.post<{ marked: number }>(`/api/orders/${o.id}/read-through`, { entry_id: e.id, path: editing ? "all" : path }),
                  (r) => r.marked ? `Marked ${plural(r.marked, "issue")} read` : "Already read").then(reload)}
                onToggle={() => run(() => e.type === "arc"
                  ? api.put(`/api/arcs/${e.arc!.id}/read`, { read: !e.done })
                  : api.put(`/api/issues/${e.issue!.id}/read`, { read: !e.done }), e.done ? "Marked unread" : "Marked read").then(reload)}
                onChange={reload} />
            ))}
          </ol>
        )}

        {editing && <AddEntry orderId={o.id} onAdded={reload} />}
      </div>
    </>
  );
}

function EntryRow({ entry: e, index, count, isNext, editing, busy, onReadThrough, onToggle, onChange }: {
  entry: OrderEntry; index: number; count: number; isNext: boolean; editing: boolean; busy: boolean;
  onReadThrough: () => void; onToggle: () => void; onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { run } = useAction();
  const title = e.type === "issue" ? `${e.issue!.series_name} #${e.issue!.number}` : e.arc!.name;
  const href = e.type === "issue" ? `/issue?id=${e.issue!.id}` : `/arc?id=${e.arc!.id}`;
  const cover = e.type === "issue" ? e.issue!.image_url : e.arc!.image_url ?? e.issues?.[0]?.image_url;
  const patch = (body: object, msg = "Saved") => run(() => api.patch(`/api/admin/entries/${e.id}`, body), msg).then(onChange);
  return (
    <li className="card" style={{ padding: 12, borderColor: isNext ? "var(--ink)" : undefined, borderWidth: isNext ? 2 : 1, opacity: e.done && !editing ? 0.72 : 1 }}>
      <div style={{ display: "grid", gridTemplateColumns: "64px 1fr auto", gap: 14, alignItems: "start" }}>
        <Link href={href} aria-label={title}>
          <Cover src={cover} alt="" fallback={title}>{e.type === "issue" && <CornerBox number={e.issue!.number} />}</Cover>
        </Link>
        <div className="stack" style={{ gap: 6, minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="mono">{String(index + 1).padStart(2, "0")}</span>
            <TierChip tier={e.tier} />
            {isNext && <span className="tier tier-optional">Up next</span>}
          </div>
          <Link href={href} className="h3">{title}</Link>
          <span className="mono">{e.type === "arc" ? `${e.arc!.kind === "event" ? "Event" : "Arc"} · ${plural(e.issue_count, "issue")}` : e.issue!.title ?? ""}</span>
          {e.note && <span className="small">{e.note}</span>}
          {e.prerequisites.length > 0 && (
            <span className="small muted">Read first: {e.prerequisites.map((p, i) => (
              <span key={`${p.type}${p.id}`}>{i > 0 && ", "}<Link href={p.type === "arc" ? `/arc?id=${p.id}` : `/issue?id=${p.id}`} style={{ color: "var(--cyan-ink)", fontWeight: 600 }}>{p.name ?? "an issue"}</Link></span>
            ))}</span>
          )}
          {e.type === "arc" && e.issue_count > 1 && <ProgressBar read={e.read_count} total={e.issue_count} thin />}
          {e.type === "arc" && e.issues && e.issues.length > 0 && (
            <details className="disclosure small" open={open} onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}>
              <summary>{plural(e.issues.length, "issue")}</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {e.issues.map((i) => <li key={i.id}><Link href={`/issue?id=${i.id}`}>{i.series_name} #{i.number}</Link>{i.read ? " ✓" : ""}</li>)}
              </ul>
            </details>
          )}
        </div>
        <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
          <button className="btn small" style={{ background: e.done ? "var(--yellow)" : undefined, color: e.done ? "#15171c" : undefined }}
            onClick={onToggle} disabled={busy} aria-pressed={e.done} aria-label={e.done ? `Mark ${title} unread` : `Mark ${title} read`}>
            <I.Check />{e.done ? "Read" : "Mark read"}
          </button>
          {!e.done && index > 0 && !editing && <button className="btn ghost small" onClick={onReadThrough} disabled={busy}>Read up to here</button>}
        </div>
      </div>
      {editing && (
        <div className="row" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--rule)" }}>
          <label className="visually-hidden" htmlFor={`tier-${e.id}`}>Tier</label>
          <select id={`tier-${e.id}`} className="select" style={{ width: 160 }} value={e.tier} onChange={(ev) => patch({ tier: ev.target.value as Tier })}>
            {TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
          </select>
          <button className="btn secondary small" aria-label="Move up" disabled={index === 0} onClick={() => patch({ position: e.position - 1 }, "Moved")}><I.Up /></button>
          <button className="btn secondary small" aria-label="Move down" disabled={index === count - 1} onClick={() => patch({ position: e.position + 1 }, "Moved")}><I.Down /></button>
          <NoteEditor initial={e.note ?? ""} onSave={(note) => patch({ note: note || null }, "Note saved")} />
          <div style={{ minWidth: 220, flex: 1 }}>
            <Picker kind="arc" label="Add a prerequisite arc" placeholder="Needs an arc first…"
              onPick={(a) => run(() => api.post(`/api/admin/entries/${e.id}/prerequisites`, { requires_arc_id: a.id }), `Added ${a.label} as a prerequisite`).then(onChange)} />
          </div>
          <button className="btn danger small" onClick={() => run(() => api.del(`/api/admin/entries/${e.id}`), "Entry removed").then(onChange)}><I.X />Remove</button>
        </div>
      )}
    </li>
  );
}

function NoteEditor({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <form className="row" style={{ flex: 1, minWidth: 220, gap: 6 }} onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); }}>
      <input className="input" value={v} onChange={(e) => setV(e.target.value)} placeholder="Note for readers" aria-label="Note" style={{ flex: 1 }} />
      <button className="btn secondary small" disabled={v === initial}>Save note</button>
    </form>
  );
}

function OrderEditorHead({ order, onChange }: { order: OrderDetail; onChange: () => void }) {
  const { run, busy } = useAction();
  const router = useRouter();
  const [name, setName] = useState(order.name);
  const [desc, setDesc] = useState(order.description ?? "");
  return (
    <div className="card stack">
      <span className="eyebrow">Editing · curate mode is on</span>
      <label className="label">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="label">Description<textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <div className="row">
        <button className="btn small" disabled={busy} onClick={() => run(() => api.patch(`/api/admin/orders/${order.id}`, { name, description: desc || null }), "Order saved").then(onChange)}>Save details</button>
        <span className="mono">{TIERS.map((t) => `${TIER_LABEL[t]} ${order.tier_counts[t]}`).join(" · ")}</span>
        <span style={{ flex: 1 }} />
        <button className="btn danger small" disabled={busy} onClick={() => {
          if (confirm(`Delete "${order.name}"? This can't be undone.`)) run(() => api.del(`/api/admin/orders/${order.id}`), "Order deleted").then(() => router.push("/orders"));
        }}>Delete order</button>
      </div>
      {order.source === "generated" && <p className="small muted" style={{ margin: 0 }}>This is a generated draft. Your first edit makes it a curated order, so regenerating won&rsquo;t overwrite it.</p>}
    </div>
  );
}

function AddEntry({ orderId, onAdded }: { orderId: number; onAdded: () => void }) {
  const [tier, setTier] = useState<Tier>("recommended");
  const { run } = useAction();
  const add = (body: object, label: string) => run(() => api.post(`/api/admin/orders/${orderId}/entries`, { ...body, tier }), `Added ${label}`).then(onAdded);
  return (
    <div className="card stack">
      <strong className="h3">Add to this order</strong>
      <div className="row">
        <label className="visually-hidden" htmlFor="newtier">Tier for new entries</label>
        <select id="newtier" className="select" style={{ width: 170 }} value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
          {TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
        </select>
        <Picker kind="arc" label="Add an arc or event" placeholder="Add an arc or event…" onPick={(o) => add({ arc_id: o.id }, o.label)} />
        <Picker kind="issue" label="Add a single issue" placeholder="Add a single issue…" onPick={(o) => add({ issue_id: o.id }, o.label)} />
      </div>
    </div>
  );
}

export default withParams(OrderPage);
