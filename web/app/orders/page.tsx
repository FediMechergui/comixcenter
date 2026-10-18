"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OrderTile } from "@/components/cards";
import * as I from "@/components/icons";
import { Empty, ErrorBox, Loading, PageHead, Section, Segmented, useAction, useCurateMode } from "@/components/ui";
import { api, qs, useApi } from "@/lib/api";
import type { OrderCard } from "@/lib/types";
import { GuideShelf } from "@/components/guides";
import { guides } from "@/lib/guides";
import Link from "next/link";

const KINDS = [
  { value: "all", label: "All" }, { value: "universe", label: "Universes" }, { value: "event", label: "Events" },
  { value: "character", label: "Characters" }, { value: "team", label: "Teams" }, { value: "writer", label: "Writers" }, { value: "custom", label: "Lists" },
];

export default function OrdersPage() {
  const [kind, setKind] = useState("all");
  const { data, error, mutate } = useApi<OrderCard[]>(`/api/orders${qs({ kind: kind === "all" ? null : kind })}`);
  const [curate] = useCurateMode();
  const inProgress = data?.filter((o) => o.progress.paths.core.read > 0 && o.progress.paths.core.read < o.progress.paths.core.issues) ?? [];
  const rest = data?.filter((o) => !inProgress.includes(o)) ?? [];
  return (
    <>
      <PageHead eyebrow="Reading orders" title="Find your path">
        <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>
          Every order is tiered. Read only the essentials, the core path, or everything down to the last tie-in.
          Issues you&rsquo;ve read count in every order that includes them.
        </p>
      </PageHead>
      <div className="stack-lg">
        <Section title="Ready to read" action={<Link href="/guides">All reading guides</Link>}><GuideShelf items={guides.filter((g) => g.tags.includes("Mainline")).slice(0, 4)} /></Section>
        <Segmented label="Order type" value={kind} onChange={setKind} options={KINDS} />
        {error && <ErrorBox error={error} retry={() => mutate()} />}
        {!data && !error && <Loading lines={6} />}
        {curate && <NewOrder />}
        {data && data.length === 0 && (
          <Empty title="No reading orders yet">
            Draft one from an event, character, team or writer page in curate mode, or import a Metron reading list in Curate.
          </Empty>
        )}
        {inProgress.length > 0 && <Section title="In progress"><div className="grid-cards">{inProgress.map((o) => <OrderTile key={o.id} o={o} />)}</div></Section>}
        {rest.length > 0 && <Section title={inProgress.length ? "More orders" : "Orders"}><div className="grid-cards">{rest.map((o) => <OrderTile key={o.id} o={o} />)}</div></Section>}
      </div>
    </>
  );
}

function NewOrder() {
  const [name, setName] = useState("");
  const { run, busy } = useAction();
  const router = useRouter();
  return (
    <form className="card flat row" onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim()) return;
      run(() => api.post<OrderCard>("/api/admin/orders", { name: name.trim(), kind: "custom" }), "Reading order created")
        .then((o) => o && router.push(`/order?id=${o.id}`));
    }}>
      <label className="visually-hidden" htmlFor="newo">New reading order name</label>
      <input id="newo" className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Name a new reading order" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn" disabled={busy || !name.trim()}><I.Plus />Create order</button>
    </form>
  );
}
