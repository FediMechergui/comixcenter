"use client";
import { useEffect, useState } from "react";
import { Pager, SeriesRow, SeriesTile } from "@/components/cards";
import { useNumberParam, useSetParams, useStringParam, withParams } from "@/components/params";
import { Empty, ErrorBox, Loading, PageHead, plural, Segmented } from "@/components/ui";
import { qs, useApi } from "@/lib/api";
import type { Page, PublisherDetail, SeriesCard, UniverseDetail } from "@/lib/types";

/** Grid or list is a per-reader habit, so it is remembered rather than reset on every visit. */
const VIEW_KEY = "comix.seriesView";
type View = "list" | "grid";

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("list");
  useEffect(() => {
    try { const v = localStorage.getItem(VIEW_KEY); if (v === "grid" || v === "list") setView(v); } catch { /* private mode */ }
  }, []);
  return [view, (v) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: this visit only */ }
  }];
}

function SeriesListPage() {
  const [view, setView] = useView();
  const publisher = useNumberParam("publisher");
  const universe = useNumberParam("universe");
  const era = useNumberParam("era");
  const unclassified = useStringParam("unclassified") === "1";
  const collected = useStringParam("collected");
  const sort = (useStringParam("sort") as "name" | "year" | "recent") || "name";
  const page = useNumberParam("page") ?? 1;
  const q = useStringParam("q") ?? "";
  const setParams = useSetParams();
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => { if (text !== q) setParams({ q: text, page: null }); }, 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);

  const path = `/api/series${qs({ publisher_id: publisher, universe_id: universe, era_id: era, unclassified: unclassified || null,
    collected, sort, page, size: 50, q })}`;
  const { data, error, mutate } = useApi<Page<SeriesCard>>(path, { keepPreviousData: true });
  const uni = useApi<UniverseDetail>(universe ? `/api/universes/${universe}` : null);
  const pub = useApi<PublisherDetail>(publisher ? `/api/publishers/${publisher}` : null);
  const eraName = uni.data?.eras.find((e) => e.id === era)?.name;
  const title = eraName ?? uni.data?.name ?? (unclassified ? `Other ${pub.data?.name ?? ""} series` : collected === "true" ? "Collected editions" : pub.data ? `${pub.data.name} series` : "All series");

  return (
    <>
      <PageHead eyebrow={eraName ? uni.data?.name : "Series"} title={title}
        crumbs={[{ href: "/browse", label: "Browse" },
          ...(uni.data ? [{ href: `/universe?id=${uni.data.id}`, label: uni.data.name }] : pub.data ? [{ href: `/publisher?id=${pub.data.id}`, label: pub.data.name }] : []),
          { label: eraName ?? "Series" }]} />
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="visually-hidden" htmlFor="filter">Filter series</label>
        <input id="filter" className="input" style={{ maxWidth: 320 }} placeholder="Filter by name" value={text} onChange={(e) => setText(e.target.value)} />
        <Segmented label="Sort" value={sort} onChange={(v) => setParams({ sort: v === "name" ? null : v, page: null })}
          options={[{ value: "name", label: "A–Z" }, { value: "year", label: "Oldest" }, { value: "recent", label: "Latest" }]} />
        <Segmented label="View" value={view} onChange={setView}
          options={[{ value: "list", label: "List" }, { value: "grid", label: "Grid" }]} />
        {data && <span className="mono">{plural(data.total, "series", "series")}</span>}
      </div>
      {error && <ErrorBox error={error} retry={() => mutate()} />}
      {!data && !error && <Loading lines={8} />}
      {data && data.items.length === 0 && <Empty title="No series here yet">Sync series from Metron in Curate, or widen the filter.</Empty>}
      {data && data.items.length > 0 && (
        <>
          {view === "grid"
            ? <div className="grid-covers">{data.items.map((s) => <SeriesTile key={s.id} s={s} />)}</div>
            : <div className="list">{data.items.map((s) => <SeriesRow key={s.id} s={s} />)}</div>}
          <Pager page={data.page} size={data.size} total={data.total} onPage={(p) => setParams({ page: p })} />
        </>
      )}
    </>
  );
}

export default withParams(SeriesListPage);
