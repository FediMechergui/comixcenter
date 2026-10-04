"use client";
import { useEffect, useState } from "react";
import { Pager, TeamRow } from "@/components/cards";
import { useNumberParam, useSetParams, useStringParam, withParams } from "@/components/params";
import { Empty, ErrorBox, Loading, PageHead, plural } from "@/components/ui";
import { qs, useApi } from "@/lib/api";
import type { Page, TeamCard } from "@/lib/types";

function TeamsPage() {
  const q = useStringParam("q") ?? "";
  const page = useNumberParam("page") ?? 1;
  const setParams = useSetParams();
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => { if (text !== q) setParams({ q: text, page: null }); }, 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);
  const { data, error, mutate } = useApi<Page<TeamCard>>(`/api/teams${qs({ q, page, size: 60 })}`, { keepPreviousData: true });
  return (
    <>
      <PageHead eyebrow="Catalog" title="Teams" />
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="visually-hidden" htmlFor="tq">Find a team</label>
        <input id="tq" className="input" style={{ maxWidth: 340 }} placeholder="Find a team" value={text} onChange={(e) => setText(e.target.value)} />
        {data && <span className="mono">{plural(data.total, "team")}</span>}
      </div>
      {error && <ErrorBox error={error} retry={() => mutate()} />}
      {!data && !error && <Loading lines={8} />}
      {data && data.items.length === 0 && <Empty title="No teams yet">Teams arrive with issue details, or sync one directly in Curate.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <div className="list">{data.items.map((t) => <TeamRow key={t.id} t={t} />)}</div>
          <Pager page={data.page} size={data.size} total={data.total} onPage={(p) => setParams({ page: p })} />
        </>
      )}
    </>
  );
}

export default withParams(TeamsPage);
