"use client";
import Link from "next/link";
import { Empty, ErrorBox, Loading, PageHead, plural, Section } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { PublisherCard, Status, UniverseCard } from "@/lib/types";

export default function BrowsePage() {
  const { data, error, mutate } = useApi<PublisherCard[]>("/api/publishers");
  const status = useApi<Status>("/api/status");
  const universes = useApi<UniverseCard[]>("/api/universes");
  return (
    <>
      <PageHead eyebrow="Catalog" title="Browse" />
      {universes.data && <Section title="Universes & mainlines"><div className="universe-browser">{universes.data.map((u) => <Link key={u.id} href={`/universe?id=${u.id}`} className="universe-browser-row"><div><span className="eyebrow">{u.publisher || u.kind}</span><strong>{u.name}</strong><p>{u.description}</p></div><span className="mono">{u.series_count} series</span></Link>)}</div></Section>}
      {error && <ErrorBox error={error} retry={() => mutate()} />}
      {!data && !error && <Loading />}
      {data && (
        <div className="stack-lg">
          <Section title="Publishers">
            {data.length === 0 ? <Empty title="No publishers yet">Sync something from Metron in Curate.</Empty> : (
              <div className="grid-cards">
                {data.map((p) => (
                  <Link key={p.id} href={`/publisher?id=${p.id}`} className="card card-link stack" style={{ gap: 6 }}>
                    <strong className="h2">{p.name}</strong>
                    <span className="mono">{plural(p.universe_count, "universe")} · {plural(p.series_count, "series", "series")}</span>
                  </Link>
                ))}
              </div>
            )}
          </Section>
          <Section title="Across the catalog">
            <div className="grid-cards">
              <Link href="/arcs" className="card card-link stack" style={{ gap: 6 }}>
                <strong className="h2">Arcs &amp; events</strong>
                <span className="mono">{plural(status.data?.counts.arcs ?? 0, "arc")}</span>
              </Link>
              <Link href="/characters" className="card card-link stack" style={{ gap: 6 }}>
                <strong className="h2">Characters</strong>
                <span className="mono">{plural(status.data?.counts.characters ?? 0, "character")}</span>
              </Link>
              <Link href="/teams" className="card card-link stack" style={{ gap: 6 }}>
                <strong className="h2">Teams</strong>
                <span className="mono">{plural(status.data?.counts.teams ?? 0, "team")}</span>
              </Link>
              <Link href="/series-list?collected=true" className="card card-link stack" style={{ gap: 6 }}>
                <strong className="h2">Collected editions</strong>
                <span className="mono">Trades, hardcovers, omnibuses</span>
              </Link>
            </div>
          </Section>
        </div>
      )}
    </>
  );
}
