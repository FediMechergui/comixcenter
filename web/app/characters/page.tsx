"use client";
import { useEffect, useState } from "react";
import { CharacterRow, Pager } from "@/components/cards";
import { useNumberParam, useSetParams, useStringParam, withParams } from "@/components/params";
import { Empty, ErrorBox, Loading, PageHead, plural } from "@/components/ui";
import { qs, useApi } from "@/lib/api";
import type { CharacterCard, Page } from "@/lib/types";
import { GuideShelf } from "@/components/guides";
import { guides } from "@/lib/guides";

function CharactersPage() {
  const q = useStringParam("q") ?? "";
  const page = useNumberParam("page") ?? 1;
  const setParams = useSetParams();
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => { if (text !== q) setParams({ q: text, page: null }); }, 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);
  const { data, error, mutate } = useApi<Page<CharacterCard>>(`/api/characters${qs({ q, page, size: 60 })}`, { keepPreviousData: true });
  return (
    <>
      <PageHead eyebrow="Catalog" title="Characters" />
      <div className="character-journey"><GuideShelf items={guides.filter((g) => g.tags.includes("Character") && (!q || `${g.title} ${g.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())))} /></div>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="visually-hidden" htmlFor="cq">Find a character</label>
        <input id="cq" className="input" style={{ maxWidth: 340 }} placeholder="Name, hero name or real name" value={text} onChange={(e) => setText(e.target.value)} />
        {data && <span className="mono">{plural(data.total, "character")}</span>}
      </div>
      {error && <ErrorBox error={error} retry={() => mutate()} />}
      {!data && !error && <Loading lines={8} />}
      {data && data.items.length === 0 && <Empty title="No characters yet">Characters arrive with issue details, or sync one directly in Curate.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <div className="list">{data.items.map((c) => <CharacterRow key={c.id} c={c} />)}</div>
          <Pager page={data.page} size={data.size} total={data.total} onPage={(p) => setParams({ page: p })} />
        </>
      )}
    </>
  );
}

export default withParams(CharactersPage);
