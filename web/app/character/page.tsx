"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Cover, IssueTile, Pager } from "@/components/cards";
import * as I from "@/components/icons";
import { useNumberParam, useSetParams, useStringParam, withParams } from "@/components/params";
import { Picker } from "@/components/pickers";
import { ErrorBox, Facts, formatDate, Loading, PageHead, plural, Section, Segmented, useAction, useCurateMode } from "@/components/ui";
import { api, qs, useApi } from "@/lib/api";
import type { Appearance, CharacterDetail, IdentityDetail, OrderCard, Page, UniverseDetail } from "@/lib/types";

const EVENT_LABEL: Record<string, string> = { first_appearance: "First appearance", death: "Death", resurrection: "Return", costume: "Costume era" };

function CharacterPage() {
  const id = useNumberParam("id");
  const { data: c, error, mutate } = useApi<CharacterDetail>(id ? `/api/characters/${id}` : null);
  const graph = useApi<{ links: { character_id: number; name: string; image_url: string | null; teams: { team_id: number; name: string }[] }[] }>(id ? `/api/characters/${id}/graph` : null);
  const [curate] = useCurateMode();
  const { run, busy } = useAction();
  const router = useRouter();
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!c) return <Loading lines={6} />;
  const people = c.identities.filter((i) => i.display_name !== c.name);

  return (
    <>
      <PageHead eyebrow={people.length > 1 ? `${people.length} people have carried this name` : "Character"} title={c.name}
        crumbs={[{ href: "/characters", label: "Characters" }, { label: c.name }]}>
        <Facts items={[[c.appearances, "Appearances"], [c.teams.length || null, "Teams"], [c.universes.length || null, "Universes"]]} />
        {curate && (
          <div className="row">
            <button className="btn secondary small" disabled={busy}
              onClick={() => run(() => api.post<OrderCard>("/api/admin/orders/generate", { source: "character", id: c.id }), "Reading order drafted").then((o) => o && router.push(`/order?id=${o.id}`))}>
              <I.Path />Draft a reading order
            </button>
          </div>
        )}
      </PageHead>

      <div className="stack-lg">
        <div className="grid-cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {c.identities.map((ident) => <IdentityCard key={ident.id} ident={ident} character={c} curate={curate} onChange={() => mutate()} />)}
        </div>

        {c.reading_orders.length > 0 && (
          <Section title="Reading orders">
            <div className="row">{c.reading_orders.map((o) => <Link key={o.id} className="chip" href={`/order?id=${o.id}`}>{o.name}</Link>)}</div>
          </Section>
        )}

        {c.teams.length > 0 && (
          <Section title="Teams">
            <div className="list">
              {c.teams.map((t, i) => (
                <Link key={`${t.id}-${i}`} href={`/team?id=${t.id}`} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                  <span className="body"><strong>{t.name}</strong>{t.identity !== c.name && <span className="mono">as {t.identity}</span>}</span>
                  <span className="mono">{t.since ? `${formatDate(t.since, "year")}–${t.until ? formatDate(t.until, "year") : ""}` : ""}</span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        {graph.data && graph.data.links.length > 0 && (
          <Section title="Served alongside">
            <p className="small muted" style={{ margin: 0 }}>Characters who shared a team with {c.name}, most shared teams first.</p>
            <div className="grid-cards">
              {graph.data.links.slice(0, 12).map((l) => (
                <Link key={l.character_id} href={`/character?id=${l.character_id}`} className="card card-link stack" style={{ gap: 6, padding: 12 }}>
                  <strong>{l.name}</strong>
                  <span className="row" style={{ gap: 4 }}>{l.teams.map((t) => <span key={t.team_id} className="chip" style={{ fontSize: "0.72rem" }}>{t.name}</span>)}</span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        <AppearanceIndex character={c} />
      </div>
    </>
  );
}

function IdentityCard({ ident, character, curate, onChange }: { ident: IdentityDetail; character: CharacterDetail; curate: boolean; onChange: () => void }) {
  const { run } = useAction();
  const router = useRouter();
  const [eventKind, setEventKind] = useState("death");
  const [eventText, setEventText] = useState("");
  return (
    <article className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        {ident.image_url && <div style={{ width: 64, flexShrink: 0 }}><Cover src={ident.image_url} alt="" fallback={ident.display_name} /></div>}
        <div className="stack" style={{ gap: 2 }}>
          <strong className="h3">{ident.display_name}</strong>
          {ident.real_name && ident.real_name !== ident.display_name && <span className="small muted">{ident.real_name}</span>}
          <span className="mono">{plural(ident.appearances, "appearance")}{ident.first_seen ? ` · ${formatDate(ident.first_seen, "year")}–${formatDate(ident.last_seen, "year")}` : ""}</span>
          {ident.aliases.length > 0 && <span className="small muted">Also: {ident.aliases.slice(0, 5).join(", ")}</span>}
        </div>
      </div>
      {ident.first_appearance && (
        <div className="small"><span className="tier tier-essential">First appearance</span>{" "}
          {ident.first_appearance.id ? <Link href={`/issue?id=${ident.first_appearance.id}`} style={{ fontWeight: 700 }}>{ident.first_appearance.label}</Link> : ident.first_appearance.label}
        </div>
      )}
      {ident.events.filter((e) => e.kind !== "first_appearance").map((e) => (
        <div key={e.id} className="small between">
          <span><span className="tier tier-tie_in">{EVENT_LABEL[e.kind] ?? e.kind}</span>{" "}
            {e.issue?.id ? <Link href={`/issue?id=${e.issue.id}`} style={{ fontWeight: 600 }}>{e.issue.label}</Link> : e.issue?.label}
            {e.end_issue && <> to <Link href={`/issue?id=${e.end_issue.id}`}>{e.end_issue.label}</Link></>}
            {e.note && <span className="muted"> — {e.note}</span>}</span>
          {curate && e.source === "curated" && (
            <button className="btn ghost small" onClick={() => run(() => api.del(`/api/admin/character-events/${e.id}`), "Removed").then(onChange)}><I.X /></button>
          )}
        </div>
      ))}
      {ident.description && <p className="small clamp-3" style={{ margin: 0 }}>{ident.description}</p>}
      {curate && (
        <div className="stack" style={{ gap: 8, borderTop: "1px dashed var(--rule)", paddingTop: 10 }}>
          <span className="eyebrow">Curate</span>
          <Picker kind="character" label="Move under another name" placeholder="Move under another character…"
            onPick={(o) => run(() => api.patch(`/api/admin/identities/${ident.id}`, { character_id: o.id }), `Moved to ${o.label}`)
              .then(() => character.identities.length === 1 ? router.push(`/character?id=${o.id}`) : onChange())} />
          <form className="row" style={{ gap: 6 }} onSubmit={(e) => {
            e.preventDefault();
            if (!eventText.trim()) return;
            run(() => api.post("/api/admin/character-events", { identity_id: ident.id, kind: eventKind, issue_text: eventText.trim() }), "Added").then(() => { setEventText(""); onChange(); });
          }}>
            <select className="select" style={{ width: 150 }} value={eventKind} onChange={(e) => setEventKind(e.target.value)} aria-label="Event kind">
              <option value="death">Death</option><option value="resurrection">Return</option><option value="costume">Costume era</option>
            </select>
            <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Issue, e.g. X-Men #137" value={eventText} onChange={(e) => setEventText(e.target.value)} aria-label="Issue" />
            <button className="btn secondary small">Add</button>
          </form>
        </div>
      )}
    </article>
  );
}

function AppearanceIndex({ character }: { character: CharacterDetail }) {
  const identity = useNumberParam("identity");
  const role = useStringParam("role") ?? "";
  const universe = useNumberParam("universe");
  const era = useNumberParam("era");
  const page = useNumberParam("page") ?? 1;
  const setParams = useSetParams();
  const uni = useApi<UniverseDetail>(universe ? `/api/universes/${universe}` : null);
  const { data } = useApi<Page<Appearance>>(`/api/characters/${character.id}/appearances${qs({ identity_id: identity, role, universe_id: universe, era_id: era, page, size: 48 })}`, { keepPreviousData: true });
  return (
    <Section title="Appearances" id="appearances">
      <div className="row">
        {character.identities.length > 1 && (
          <select className="select" style={{ width: "auto" }} aria-label="Identity" value={identity ?? ""} onChange={(e) => setParams({ identity: e.target.value || null, page: null })}>
            <option value="">Everyone</option>
            {character.identities.map((i) => <option key={i.id} value={i.id}>{i.display_name}</option>)}
          </select>
        )}
        <Segmented label="Role" value={role || "all"} onChange={(v) => setParams({ role: v === "all" ? null : v, page: null })}
          options={[{ value: "all", label: "Any role" }, { value: "main", label: "Lead" }, { value: "supporting", label: "Supporting" }, { value: "cameo", label: "Cameo" }]} />
        {character.universes.length > 0 && (
          <select className="select" style={{ width: "auto" }} aria-label="Universe" value={universe ?? ""} onChange={(e) => setParams({ universe: e.target.value || null, era: null, page: null })}>
            <option value="">All universes</option>
            {character.universes.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.issues})</option>)}
          </select>
        )}
        {uni.data && uni.data.eras.length > 1 && (
          <select className="select" style={{ width: "auto" }} aria-label="Era" value={era ?? ""} onChange={(e) => setParams({ era: e.target.value || null, page: null })}>
            <option value="">All eras</option>
            {uni.data.eras.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        {data && <span className="mono">{plural(data.total, "issue")}</span>}
      </div>
      {!data ? <Loading /> : data.items.length === 0 ? <p className="muted">No appearances match these filters.</p> : (
        <>
          <div className="grid-covers">{data.items.map((a) => <IssueTile key={`${a.id}-${a.identity_id}`} issue={a} />)}</div>
          <Pager page={data.page} size={data.size} total={data.total} onPage={(p) => setParams({ page: p })} />
        </>
      )}
    </Section>
  );
}

export default withParams(CharacterPage);
