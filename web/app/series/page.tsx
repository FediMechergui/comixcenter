"use client";
import Link from "next/link";
import { useState } from "react";
import { Cover, IssueTile } from "@/components/cards";
import * as I from "@/components/icons";
import { useNumberParam, withParams } from "@/components/params";
import { ErrorBox, Facts, formatDate, Loading, PageHead, plural, ProgressBar, Section, useAction, useCurateMode } from "@/components/ui";
import { api, refresh, useApi } from "@/lib/api";
import type { PublisherDetail, SeriesDetail } from "@/lib/types";

function SeriesPage() {
  const id = useNumberParam("id");
  const key = id ? `/api/series/${id}` : null;
  const { data, error, mutate } = useApi<SeriesDetail>(key);
  const { run, busy } = useAction();
  const [curate] = useCurateMode();
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!data) return <Loading lines={6} />;
  const allRead = data.issues.length > 0 && data.read_count >= data.issues.length;
  const years = data.year_began ? `${data.year_began}${data.year_end && data.year_end !== data.year_began ? `–${data.year_end}` : data.year_end ? "" : "–"}` : null;

  return (
    <>
      <PageHead eyebrow={[data.publisher, data.imprint, data.series_type].filter(Boolean).join(" · ") || "Series"}
        title={`${data.name}${data.volume && data.volume > 1 ? ` Vol. ${data.volume}` : ""}`}
        crumbs={[{ href: "/browse", label: "Browse" }, ...(data.publisher_id ? [{ href: `/publisher?id=${data.publisher_id}`, label: data.publisher ?? "" }] : []), { label: data.name }]}>
        <div className="row">
          {data.universes.map((u) => <Link key={u.id} className="chip" href={`/universe?id=${u.id}`}>{u.name}</Link>)}
          {data.eras.map((e) => <Link key={e.id} className="chip" href={`/series-list?universe=${e.universe_id}&era=${e.id}`}>{e.name}</Link>)}
        </div>
      </PageHead>

      <div className="stack-lg">
        <div className="row" style={{ alignItems: "flex-start", gap: 20 }}>
          <div style={{ width: 140, flexShrink: 0 }}><Cover src={data.image_url} alt={`${data.name} cover`} fallback={data.name} /></div>
          <div className="stack" style={{ flex: 1, minWidth: 220 }}>
            <Facts items={[[years, "Published"], [data.issues.length, "Issues"], [data.read_count, "Read"], [data.status, "Status"]]} />
            {data.issues.length > 0 && <ProgressBar read={data.read_count} total={data.issues.length} />}
            {data.description && <p className="prose" style={{ margin: 0 }}>{data.description}</p>}
            <div className="row">
              <button className="btn secondary small" disabled={busy}
                onClick={() => run(() => api.put(`/api/series/${data.id}/read`, { read: !allRead }), allRead ? "Marked unread" : "Marked every issue read").then(() => refresh(key!, "/api/progress", "/api/orders"))}>
                <I.Check />{allRead ? "Mark all unread" : "Mark all read"}
              </button>
              {curate && data.metron_id && (
                <button className="btn secondary small" disabled={busy}
                  onClick={() => run(() => api.post("/api/admin/sync", { kind: "series", metron_id: data.metron_id, deep: true }), "Queued a full sync from Metron")}>
                  <I.Refresh />Sync from Metron
                </button>
              )}
            </div>
          </div>
        </div>

        {data.arcs.length > 0 && (
          <Section title="Story arcs">
            <div className="row">{data.arcs.map((a) => <Link key={a.id} className="chip" href={`/arc?id=${a.id}`}>{a.name}<span className="count">{a.issue_count}</span></Link>)}</div>
          </Section>
        )}

        <Section title="Issues">
          {data.issues.length === 0
            ? <p className="muted">No issues synced yet{data.synced_at ? "" : " — sync this series from Curate"}.</p>
            : <div className="grid-covers">{data.issues.map((i) => <IssueTile key={i.id} issue={i} showSeries={false} />)}</div>}
        </Section>

        {data.writers.length > 0 && (
          <Section title="Writers">
            <div className="row">
              {data.writers.map((w) => <Link key={w.id} className="chip" href={`/creator?id=${w.id}`}>{w.name}<span className="count">{w.issues}</span></Link>)}
            </div>
          </Section>
        )}

        {curate && <SeriesUniverseEditor series={data} onSaved={() => mutate()} />}
        <p className="mono">{data.metron_id ? `Metron #${data.metron_id}` : "Not linked to Metron"}{data.synced_at ? ` · synced ${formatDate(data.synced_at, "full")}` : ""}</p>
      </div>
    </>
  );
}

function SeriesUniverseEditor({ series, onSaved }: { series: SeriesDetail; onSaved: () => void }) {
  const pub = useApi<PublisherDetail>(series.publisher_id ? `/api/publishers/${series.publisher_id}` : null);
  const [picked, setPicked] = useState<number[]>(series.universes.map((u) => u.id));
  const { run, busy } = useAction();
  const options = [...(pub.data?.universes ?? []), ...(pub.data?.cross_publisher_universes ?? [])];
  return (
    <Section title="Curate: universes">
      <p className="small muted" style={{ margin: 0 }}>
        Placed by {series.universes[0]?.source ?? "nothing yet"}. Saving makes this a curated choice that syncs won't change.
      </p>
      <div className="row">
        {options.map((u) => (
          <label key={u.id} className="chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={picked.includes(u.id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, u.id] : picked.filter((x) => x !== u.id))} />
            {u.name}
          </label>
        ))}
      </div>
      <div><button className="btn small" disabled={busy}
        onClick={() => run(() => api.put(`/api/admin/series/${series.id}/universes`, { universe_ids: picked }), "Universes saved").then(onSaved)}>Save universes</button></div>
    </Section>
  );
}

export default withParams(SeriesPage);
