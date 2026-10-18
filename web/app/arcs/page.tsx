"use client";
import { useEffect, useState } from "react";
import { ArcRow, Pager } from "@/components/cards";
import { useNumberParam, useSetParams, useStringParam, withParams } from "@/components/params";
import { Empty, ErrorBox, Loading, PageHead, plural, Segmented } from "@/components/ui";
import { qs, useApi } from "@/lib/api";
import type { ArcSummary, Page } from "@/lib/types";
import { GuideShelf } from "@/components/guides";
import { guides } from "@/lib/guides";

function ArcsPage() {
  const kind = (useStringParam("kind") as "arc" | "event" | null) ?? "";
  const q = useStringParam("q") ?? "";
  const page = useNumberParam("page") ?? 1;
  const setParams = useSetParams();
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => { if (text !== q) setParams({ q: text, page: null }); }, 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);
  const { data, error, mutate } = useApi<Page<ArcSummary>>(`/api/arcs${qs({ kind, q, page, size: 40 })}`, { keepPreviousData: true });
  return (
    <>
      <PageHead eyebrow="Catalog" title="Arcs & events" />
      <div className="character-journey"><GuideShelf items={guides.filter((g) => ["marvel-modern", "dc-modern", "xmen-krakoa"].includes(g.slug))} /></div>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="visually-hidden" htmlFor="arcq">Filter arcs</label>
        <input id="arcq" className="input" style={{ maxWidth: 320 }} placeholder="Filter by name" value={text} onChange={(e) => setText(e.target.value)} />
        <Segmented label="Kind" value={kind || "all"} onChange={(v) => setParams({ kind: v === "all" ? null : v, page: null })}
          options={[{ value: "all", label: "All" }, { value: "event", label: "Events" }, { value: "arc", label: "Arcs" }]} />
        {data && <span className="mono">{plural(data.total, "result")}</span>}
      </div>
      {error && <ErrorBox error={error} retry={() => mutate()} />}
      {!data && !error && <Loading lines={8} />}
      {data && data.items.length === 0 && <Empty title="No arcs yet">Arcs arrive with issue details from Metron. Sync a series or an event in Curate.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <div className="list">{data.items.map((a) => <ArcRow key={a.id} a={a} />)}</div>
          <Pager page={data.page} size={data.size} total={data.total} onPage={(p) => setParams({ page: p })} />
        </>
      )}
    </>
  );
}

export default withParams(ArcsPage);
