"use client";
import Link from "next/link";
import { useNumberParam, withParams } from "@/components/params";
import { ErrorBox, Loading, PageHead, plural, Section } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { PublisherDetail, UniverseCard } from "@/lib/types";

const KIND_LABEL: Record<string, string> = {
  continuity: "Main continuity", alternate: "Alternate reality", line: "Imprint line", standalone: "Standalone", intercompany: "Crossovers",
};

function UniverseTile({ u }: { u: UniverseCard }) {
  return (
    <Link href={`/universe?id=${u.id}`} className="card card-link stack" style={{ gap: 6 }}>
      <span className="eyebrow">{KIND_LABEL[u.kind] ?? u.kind}{u.designation && u.designation !== u.name ? ` · ${u.designation}` : ""}</span>
      <strong className="h2">{u.name}</strong>
      {u.description && <span className="small muted clamp-3">{u.description}</span>}
      <span className="mono">{plural(u.series_count, "series", "series")}</span>
    </Link>
  );
}

function PublisherPage() {
  const id = useNumberParam("id");
  const { data, error, mutate } = useApi<PublisherDetail>(id ? `/api/publishers/${id}` : null);
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;
  const main = data.universes.filter((u) => u.kind === "continuity");
  const other = data.universes.filter((u) => u.kind !== "continuity");
  return (
    <>
      <PageHead eyebrow="Publisher" title={data.name} crumbs={[{ href: "/browse", label: "Browse" }, { label: data.name }]}>
        {data.description && <p className="prose muted clamp-3" style={{ margin: 0 }}>{data.description}</p>}
      </PageHead>
      <div className="stack-lg">
        {main.length > 0 && <Section title="Continuity"><div className="grid-cards">{main.map((u) => <UniverseTile key={u.id} u={u} />)}</div></Section>}
        {other.length > 0 && <Section title="Other realities and lines"><div className="grid-cards">{other.map((u) => <UniverseTile key={u.id} u={u} />)}</div></Section>}
        <Section title="Also">
          <div className="grid-cards">
            {data.cross_publisher_universes.map((u) => <UniverseTile key={u.id} u={u} />)}
            {data.unclassified_series_count > 0 && (
              <Link href={`/series-list?publisher=${data.id}&unclassified=1`} className="card card-link stack" style={{ gap: 6 }}>
                <span className="eyebrow">Not placed in a universe yet</span>
                <strong className="h2">Other {data.name} series</strong>
                <span className="mono">{plural(data.unclassified_series_count, "series", "series")}</span>
              </Link>
            )}
            <Link href={`/series-list?publisher=${data.id}`} className="card card-link stack" style={{ gap: 6 }}>
              <span className="eyebrow">A to Z</span>
              <strong className="h2">Every {data.name} series</strong>
            </Link>
          </div>
        </Section>
      </div>
    </>
  );
}

export default withParams(PublisherPage);
