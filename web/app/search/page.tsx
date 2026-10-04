"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Thumb } from "@/components/cards";
import { useSetParams, useStringParam, withParams } from "@/components/params";
import { Empty, ErrorBox, Loading, PageHead, Segmented } from "@/components/ui";
import { qs, useApi } from "@/lib/api";
import type { SearchHit } from "@/lib/types";

const KIND_PATH: Record<string, string> = {
  series: "/series", issue: "/issue", arc: "/arc", character: "/character", team: "/team", creator: "/creator", order: "/order",
};
const KIND_LABEL: Record<string, string> = {
  series: "Series", issue: "Issue", arc: "Arc / event", character: "Character", team: "Team", creator: "Creator", order: "Reading order",
};
const FILTERS = [
  { value: "all", label: "Everything" }, { value: "series,issue", label: "Comics" }, { value: "arc", label: "Arcs" },
  { value: "character,team", label: "Characters & teams" }, { value: "creator", label: "Creators" },
];

function SearchPage() {
  const q = useStringParam("q") ?? "";
  const kinds = useStringParam("kinds") ?? "all";
  const setParams = useSetParams();
  const [text, setText] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!q) input.current?.focus(); }, [q]);
  useEffect(() => {
    const t = setTimeout(() => { if (text.trim() !== q) setParams({ q: text.trim() || null }); }, 250);
    return () => clearTimeout(t);
  }, [text, q, setParams]);
  const { data, error, isLoading, mutate } = useApi<{ results: SearchHit[] }>(q ? `/api/search${qs({ q, kinds: kinds === "all" ? null : kinds, limit: 40 })}` : null, { keepPreviousData: true });
  return (
    <>
      <PageHead eyebrow="Catalog" title="Search" />
      <div className="stack" style={{ marginBottom: 18 }}>
        <label className="visually-hidden" htmlFor="sq">Search the catalog</label>
        <input id="sq" ref={input} className="input" type="search" style={{ fontSize: "1.1rem", minHeight: 50 }}
          placeholder="Series, issues, arcs, characters, teams, creators" value={text} onChange={(e) => setText(e.target.value)} />
        <Segmented label="Search in" value={kinds} onChange={(v) => setParams({ kinds: v === "all" ? null : v })} options={FILTERS} />
      </div>
      {error && <ErrorBox error={error} retry={() => mutate()} />}
      {q && isLoading && !data && <Loading />}
      {!q && <Empty title="Search the whole catalog">Try a hero, a writer, an event like &ldquo;Secret Wars&rdquo;, or an issue like &ldquo;amazing spider-man 300&rdquo;.</Empty>}
      {data && q && data.results.length === 0 && <Empty title={`Nothing for “${q}”`}>Only synced comics are searchable. Add more from Metron in Curate.</Empty>}
      {data && data.results.length > 0 && (
        <div className="list">
          {data.results.map((h) => (
            <Link key={`${h.kind}-${h.id}`} href={`${KIND_PATH[h.kind]}?id=${h.id}`} className="list-row">
              <Thumb src={h.image_url} round={h.kind === "character" || h.kind === "team" || h.kind === "creator"} />
              <span className="body"><strong>{h.title}</strong><span className="mono">{h.subtitle}</span></span>
              <span className="eyebrow">{KIND_LABEL[h.kind]}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export default withParams(SearchPage);
