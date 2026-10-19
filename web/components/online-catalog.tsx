"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Cover } from "./cards";
import { ErrorBox, Loading, Segmented } from "./ui";
import { qs, useApi, dataMode } from "@/lib/api";
import { FeedEntry } from "./feed";
import { SourceReader } from "./source-reader";
import type { OpdsFeedPage } from "@/lib/types";
import * as I from "./icons";

export function OnlineCatalog({ initialQuery = "", number }: { initialQuery?: string; number?: string | null }) {
  const [text, setText] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [source, setSource] = useState("auto");
  useEffect(() => { setText(initialQuery); setQuery(initialQuery); setPage(1); }, [initialQuery]);
  const result = useApi<OpdsFeedPage>(`/api/online/catalog${qs({ q: query, page, source })}`, { shouldRetryOnError: false, dedupingInterval: 300_000 });
  return <section className="section" id="latest" aria-label="Online comic sources">
    <div className="between"><div><span className="eyebrow">Read inside ComixCenter</span><h2 className="h2">{query ? "Find your next read" : "Explore online comics"}</h2></div><span className="source-label"><span />{result.data?.title || "Checking available sources"}</span></div>
    <Segmented label="Comic source" value={source} onChange={(v) => { setSource(v); setPage(1); }} options={[{ value: "auto", label: "Automatic" }, { value: "batcave", label: "Batcave" }, { value: "getcomics", label: "GetComics" }]} />
    <SourceReader url="https://batcave.biz/" title="Batcave comics" label="Browse Batcave inside the app" />
    <form className="catalog-search" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(text.trim()); }}>
      <I.Search /><label className="visually-hidden" htmlFor="source-search">Search Batcave</label>
      <input id="source-search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search a comic, character or series…" maxLength={150} />
      <button className="btn small" type="submit">Search</button>
      {query && <button className="btn ghost small" type="button" onClick={() => { setText(""); setQuery(""); setPage(1); }}>Clear</button>}
    </form>
    {result.isLoading && <><p className="small muted" role="status">Checking sources. You can switch sources or use your bundled catalog while this loads.</p><Loading lines={3} /></>}
    {result.error && <div className="source-error"><ErrorBox error={result.error} retry={() => result.mutate()} /><div className="row"><button className="btn secondary small" onClick={() => { setSource(source === "getcomics" ? "batcave" : "getcomics"); setPage(1); }}>Try {source === "getcomics" ? "Batcave" : "GetComics"}</button><Link className="text-link" href="/browse">Open bundled catalog<I.ChevronR /></Link><Link className="text-link" href="/settings">Connection settings<I.ChevronR /></Link></div></div>}
    {result.data && result.data.entries.length === 0 && <p className="muted">No comics found. Try a shorter title or leave out the year.</p>}
    {result.data?.source === "getcomics" ? <div className="list">{result.data.entries.map((entry) => dataMode() === "device" ? <FeedEntry entry={entry} feedId={-1} key={entry.title} /> : <div className="list-row" key={entry.title}><strong>{entry.title}</strong>{entry.reader_url && <Link className="btn small" href={`/read-online${qs({ url: entry.reader_url, title: entry.title, number })}`}>Read</Link>}</div>)}</div> : result.data && <div className="discovery-grid">{result.data.entries.map((entry) => <Link className="discovery-book" key={entry.reader_url || entry.title}
      href={`/read-online${qs({ url: entry.reader_url, title: entry.title, number })}`}>
      <div className="discovery-cover"><Cover src={entry.cover} alt={entry.title} fallback={entry.title} /><span className="cover-action"><I.Book />Read now</span></div>
      <strong>{entry.title}</strong><span className="small muted">{entry.author}</span>
    </Link>)}</div>}
    {result.data && <div className="between"><button className="btn secondary small" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); document.getElementById("latest")?.scrollIntoView({ behavior: "smooth" }); }}><I.ChevronL />Previous</button>
      <span className="mono">Page {page}</span><button className="btn secondary small" disabled={!result.data.next} onClick={() => { if (result.data?.source) setSource(result.data.source); setPage((p) => p + 1); document.getElementById("latest")?.scrollIntoView({ behavior: "smooth" }); }}>Next<I.ChevronR /></button></div>}
  </section>;
}
