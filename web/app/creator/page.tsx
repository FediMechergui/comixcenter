"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as I from "@/components/icons";
import { useNumberParam, withParams } from "@/components/params";
import { ErrorBox, formatDate, Loading, PageHead, plural, Section, useAction, useCurateMode } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import type { OrderCard } from "@/lib/types";

interface Creator {
  id: number; name: string;
  runs: { series_id: number; series: string; year: number | null; role: string; issues: number; from: string | null; to: string | null }[];
  reading_orders: { id: number; name: string }[];
}

function CreatorPage() {
  const id = useNumberParam("id");
  const { data: c, error, mutate } = useApi<Creator>(id ? `/api/creators/${id}` : null);
  const [curate] = useCurateMode();
  const { run, busy } = useAction();
  const router = useRouter();
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!c) return <Loading />;
  const roles = Array.from(new Set(c.runs.map((r) => r.role)));
  const draft = (seriesId?: number) => run(() => api.post<OrderCard>("/api/admin/orders/generate", { source: "writer", id: c.id, series_id: seriesId ?? null }),
    "Writer run drafted").then((o) => o && router.push(`/order?id=${o.id}`));
  return (
    <>
      <PageHead eyebrow="Creator" title={c.name} crumbs={[{ href: "/browse", label: "Browse" }, { label: c.name }]}>
        {curate && <div><button className="btn secondary small" disabled={busy} onClick={() => draft()}><I.Path />Draft complete writing order</button></div>}
      </PageHead>
      <div className="stack-lg">
        {c.reading_orders.length > 0 && <Section title="Reading orders"><div className="row">{c.reading_orders.map((o) => <Link key={o.id} className="chip" href={`/order?id=${o.id}`}>{o.name}</Link>)}</div></Section>}
        {roles.map((role) => (
          <Section key={role} title={role}>
            <div className="list">
              {c.runs.filter((r) => r.role === role).map((r) => (
                <div key={r.series_id} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                  <Link href={`/series?id=${r.series_id}`} className="body">
                    <strong>{r.series}{r.year ? ` (${r.year})` : ""}</strong>
                    <span className="mono">{plural(r.issues, "issue")} · {formatDate(r.from, "year")}{r.to && formatDate(r.to, "year") !== formatDate(r.from, "year") ? `–${formatDate(r.to, "year")}` : ""}</span>
                  </Link>
                  {curate && role.toLowerCase().includes("writer") && <button className="btn ghost small" disabled={busy} onClick={() => draft(r.series_id)}>Draft this run</button>}
                </div>
              ))}
            </div>
          </Section>
        ))}
      </div>
    </>
  );
}

export default withParams(CreatorPage);
