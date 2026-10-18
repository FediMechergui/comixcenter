"use client";
import Link from "next/link";
import { useNumberParam, withParams } from "@/components/params";
import { ErrorBox, formatDate, Loading, PageHead, plural, Section } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { UniverseDetail } from "@/lib/types";
import { GuideShelf } from "@/components/guides";
import { guides } from "@/lib/guides";

function UniversePage() {
  const id = useNumberParam("id");
  const { data, error, mutate } = useApi<UniverseDetail>(id ? `/api/universes/${id}` : null);
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;
  const multiEra = data.eras.length > 1;
  return (
    <>
      <PageHead eyebrow={data.designation && data.designation !== data.name ? data.designation : "Universe"} title={data.name}
        crumbs={[{ href: "/browse", label: "Browse" }, ...(data.publisher_id ? [{ href: `/publisher?id=${data.publisher_id}`, label: data.publisher ?? "Publisher" }] : []), { label: data.name }]}>
        {data.description && <p className="prose muted" style={{ margin: 0 }}>{data.description}</p>}
      </PageHead>
      <div className="stack-lg">
        {guides.some((g) => g.universe === data.slug) && <Section title="Start reading this universe"><GuideShelf items={guides.filter((g) => g.universe === data.slug)} /></Section>}
        <Section title={multiEra ? "Eras" : "Series"} action={<Link href={`/series-list?universe=${data.id}`}>All {plural(data.series_count, "series", "series")}</Link>}>
          {multiEra ? (
            <ol className="list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {data.eras.map((e) => (
                <li key={e.id}>
                  <Link href={`/series-list?universe=${data.id}&era=${e.id}`} className="list-row" style={{ gridTemplateColumns: "92px 1fr auto" }}>
                    <span className="mono" style={{ lineHeight: 1.2 }}>{formatDate(e.start_date, "year")}<br />{e.end_date ? `– ${formatDate(e.end_date, "year")}` : "– now"}</span>
                    <span className="body"><strong>{e.name}</strong>{e.description && <span className="small muted">{e.description}</span>}</span>
                    <span className="mono">{plural(e.series_count, "series", "series")}</span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <Link className="btn secondary" href={`/series-list?universe=${data.id}`}>Browse {plural(data.series_count, "series", "series")}</Link>
          )}
        </Section>
        {data.reading_orders.length > 0 && (
          <Section title="Master reading orders">
            <div className="row">{data.reading_orders.map((o) => <Link key={o.id} href={`/order?id=${o.id}`} className="chip">{o.name}</Link>)}</div>
          </Section>
        )}
      </div>
    </>
  );
}

export default withParams(UniversePage);
