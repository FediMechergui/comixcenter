"use client";
import Link from "next/link";
import { CornerBox, Cover, IssueTile } from "@/components/cards";
import { ReadOnlineButton } from "@/components/feed";
import * as I from "@/components/icons";
import { useNumberParam, withParams } from "@/components/params";
import { ErrorBox, Facts, formatDate, Loading, PageHead, Section, TierChip, useAction, useCurateMode } from "@/components/ui";
import { api, dataMode, refresh, useApi } from "@/lib/api";
import type { IssueDetail } from "@/lib/types";

const EVENT_LABEL: Record<string, string> = { first_appearance: "First appearance", death: "Death", resurrection: "Return", costume: "New costume" };

function IssuePage() {
  const id = useNumberParam("id");
  const key = id ? `/api/issues/${id}` : null;
  const { data: d, error, mutate } = useApi<IssueDetail>(key, { refreshInterval: (x) => (x && !x.deep_synced && dataMode() === "device" ? 4000 : 0) });
  const { run, busy } = useAction();
  const [curate] = useCurateMode();
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!d) return <Loading lines={6} />;

  const toggleRead = () => run(() => api.put(`/api/issues/${d.id}/read`, { read: !d.read }), d.read ? "Marked unread" : "Marked read")
    .then(() => refresh(key!, `/api/series/${d.series_id}`, "/api/progress", "/api/orders", "/api/arcs"));
  const file = d.files[0];

  return (
    <>
      <PageHead eyebrow={d.series.publisher ?? "Issue"} title={`${d.series_name} #${d.number}`}
        crumbs={[{ href: "/browse", label: "Browse" }, { href: `/series?id=${d.series_id}`, label: `${d.series_name}${d.series_year ? ` (${d.series_year})` : ""}` }, { label: `#${d.number}` }]}>
        {d.title && <p className="h3" style={{ color: "var(--ink-2)" }}>{d.title}</p>}
      </PageHead>

      <div className="stack-lg">
        <div className="row" style={{ alignItems: "flex-start", gap: 22 }}>
          <div style={{ width: "min(220px, 46vw)", flexShrink: 0 }}>
            <Cover src={d.image_url} alt={`Cover of ${d.series_name} #${d.number}`} fallback={d.series_name}>
              <CornerBox number={d.number} date={d.cover_date} />
            </Cover>
          </div>
          <div className="stack" style={{ flex: 1, minWidth: 240 }}>
            <Facts items={[[formatDate(d.cover_date), "Cover date"], [formatDate(d.store_date, "full"), "On sale"], [d.page_count, "Pages"]]} />
            <div className="row">
              {file
                ? <Link className="btn" href={`/read?file=${file.id}`}><I.Book />{file.current_page > 0 ? `Continue (p. ${file.current_page + 1})` : "Read your copy"}</Link>
                : <ReadOnlineButton series={d.series.name} year={d.series.year_began} number={d.number} title={`${d.series.name} #${d.number}`} />}
              <button className={`btn ${file ? "secondary" : ""}`} onClick={toggleRead} disabled={busy} aria-pressed={d.read}>
                <I.Check />{d.read ? "Read" : "Mark as read"}
              </button>
            </div>
            {d.universes.length > 0 && <div className="row">{d.universes.map((u) => <Link key={u.id} className="chip" href={`/universe?id=${u.id}`}>{u.name}</Link>)}</div>}
            {d.events.length > 0 && (
              <ul className="stack" style={{ margin: 0, padding: 0, listStyle: "none", gap: 4 }}>
                {d.events.map((e, i) => (
                  <li key={i}><span className="tier tier-essential">{EVENT_LABEL[e.kind] ?? e.kind}</span>{" "}
                    <Link href={`/character?id=${e.character_id}`} style={{ fontWeight: 700 }}>{e.name}</Link></li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {!d.deep_synced && dataMode() === "device" && <p className="small muted" role="status" style={{ margin: 0 }}>Fetching this issue&rsquo;s cover, credits and characters…</p>}
        {d.description && <Section title="The story"><p className="prose" style={{ margin: 0 }}>{d.description}</p></Section>}

        {!file && (
          <Section title="Where to read it">
            <p className="small muted" style={{ margin: 0 }}>You don&rsquo;t have this one in your library. These services carry it legally:</p>
            <div className="row">
              {d.legal_links.map((l) => (
                <a key={l.service} className="btn secondary small" href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.service}<span className="mono" style={{ fontSize: "0.68rem" }}>{l.kind}</span>
                </a>
              ))}
              <Link className="btn ghost small" href="/library"><I.Upload />Import a copy you own</Link>
            </div>
          </Section>
        )}

        {d.arcs.length > 0 && (
          <Section title="Part of">
            <div className="list">
              {d.arcs.map((a) => (
                <Link key={a.id} href={`/arc?id=${a.id}`} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                  <span className="body"><strong>{a.name}</strong><span className="mono">{a.kind === "event" ? "Event" : "Story arc"}{a.role === "tie_in" ? " · tie-in" : ""}</span></span>
                  {a.tier && <TierChip tier={a.tier} />}
                </Link>
              ))}
            </div>
          </Section>
        )}

        {d.reading_orders.length > 0 && (
          <Section title="In reading orders">
            <div className="row">{d.reading_orders.map((o) => <Link key={o.id} className="chip" href={`/order?id=${o.id}`}>{o.name}<TierChip tier={o.tier} /></Link>)}</div>
          </Section>
        )}

        {d.characters.length > 0 && (
          <Section title="Characters">
            <div className="row">
              {d.characters.map((c) => (
                <Link key={c.identity_id} className="chip" href={`/character?id=${c.character_id}`}>
                  {c.name}{c.identity !== c.name && <span className="count">{c.identity}</span>}
                  {c.role === "main" && <span className="count">lead</span>}
                </Link>
              ))}
            </div>
          </Section>
        )}

        {d.teams.length > 0 && (
          <Section title="Teams">
            <div className="row">{d.teams.map((t) => <Link key={t.id} className="chip" href={`/team?id=${t.id}`}>{t.name}</Link>)}</div>
          </Section>
        )}

        {d.credits.length > 0 && (
          <Section title="Credits">
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 18px", margin: 0 }}>
              {d.credits.map((c) => (
                <div key={c.role} style={{ display: "contents" }}>
                  <dt className="eyebrow" style={{ paddingTop: 3 }}>{c.role}</dt>
                  <dd style={{ margin: 0 }}>{c.creators.map((p, i) => <span key={p.id}>{i > 0 && ", "}<Link href={`/creator?id=${p.id}`} style={{ fontWeight: 600 }}>{p.name}</Link></span>)}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {d.collects.length > 0 && <Section title="Collects"><div className="grid-covers">{d.collects.map((i) => <IssueTile key={i.id} issue={i} />)}</div></Section>}
        {d.collected_in.length > 0 && <Section title="Collected in"><div className="grid-covers">{d.collected_in.map((i) => <IssueTile key={i.id} issue={i} />)}</div></Section>}

        <nav className="between" aria-label="Issue navigation">
          {d.previous_issue_id ? <Link className="btn secondary small" href={`/issue?id=${d.previous_issue_id}`}><I.ChevronL />Previous issue</Link> : <span />}
          {d.next_issue_id ? <Link className="btn secondary small" href={`/issue?id=${d.next_issue_id}`}>Next issue<I.ChevronR /></Link> : <span />}
        </nav>

        {curate && d.metron_id && (
          <div className="row">
            <button className="btn secondary small" disabled={busy} onClick={() => run(() => api.post("/api/admin/sync", { kind: "issue", metron_id: d.metron_id }), "Queued issue sync")}>
              <I.Refresh />{d.deep_synced ? "Refresh from Metron" : "Fetch full details from Metron"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default withParams(IssuePage);
