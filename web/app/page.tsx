"use client";
import Link from "next/link";
import { IssueTile, OrderTile } from "@/components/cards";
import * as I from "@/components/icons";
import { Empty, ErrorBox, Loading, plural, ProgressBar, Section } from "@/components/ui";
import { ApiError, apiUrl, defaultServer, serverUrl, setServerUrl, useApi } from "@/lib/api";
import { useState } from "react";
import type { LibraryFile, OrderCard, Page, Progress, PublisherCard, Status } from "@/lib/types";

export default function HomePage() {
  const status = useApi<Status>("/api/status");
  const progress = useApi<Progress>("/api/progress");
  const reading = useApi<Page<LibraryFile> & { counts: Record<string, number> }>("/api/library?status=reading&sort=read&size=8");
  const orders = useApi<OrderCard[]>("/api/orders");
  const publishers = useApi<PublisherCard[]>("/api/publishers");

  if (status.error) {
    return status.error instanceof ApiError && status.error.status === 0
      ? <ConnectCard retry={() => status.mutate()} />
      : <ErrorBox error={status.error} retry={() => status.mutate()} />;
  }
  if (!status.data) return <Loading lines={6} />;
  const s = status.data;
  const emptyCatalog = s.counts.series === 0 && s.counts.library_files === 0;

  return (
    <div className="stack-lg">
      <header className="pagehead" style={{ marginBottom: 0 }}>
        <span className="eyebrow">{plural(progress.data?.issues_read ?? 0, "issue")} read · {plural(s.counts.series, "series", "series")} in the catalog</span>
        <h1 className="title">What to read next</h1>
      </header>

      {emptyCatalog && <Onboarding status={s} />}

      {progress.data && progress.data.orders_in_progress.length > 0 && (
        <Section title="Pick up the path">
          <div className="grid-cards">
            {progress.data.orders_in_progress.slice(0, 4).map((o) => <OrderTile key={o.id} o={o} />)}
          </div>
        </Section>
      )}

      {reading.data && reading.data.items.length > 0 && (
        <Section title="Continue reading" action={<Link href="/library">Library</Link>}>
          <div className="scroller">
            {reading.data.items.map((f) => (
              <Link key={f.id} href={`/read?file=${f.id}`} className="issue-tile card-link">
                <div className="cover"><img src={apiUrl(f.cover_url)} alt="" loading="lazy" /></div>
                <span className="meta">
                  <strong>{f.issue ? `${f.issue.series_name} #${f.issue.number}` : f.name}</strong>
                  <span className="mono">Page {f.current_page + 1} of {f.page_count}</span>
                  <ProgressBar read={f.current_page + 1} total={f.page_count} thin />
                </span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {progress.data && progress.data.recent.length > 0 && (
        <Section title="Recently read">
          <div className="scroller">{progress.data.recent.map((i) => <IssueTile key={i.id} issue={i} />)}</div>
        </Section>
      )}

      {orders.data && orders.data.length > 0 && (
        <Section title="Reading orders" action={<Link href="/orders">All orders</Link>}>
          <div className="grid-cards">{orders.data.slice(0, 6).map((o) => <OrderTile key={o.id} o={o} />)}</div>
        </Section>
      )}

      {publishers.data && publishers.data.length > 0 && (
        <Section title="Browse by publisher" action={<Link href="/browse">Everything</Link>}>
          <div className="row">
            {publishers.data.map((p) => (
              <Link key={p.id} href={`/publisher?id=${p.id}`} className="chip">
                {p.name}<span className="count">{p.series_count}</span>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Onboarding({ status }: { status: Status }) {
  const keys = status.sources.metron;
  return (
    <section className="card stack" aria-labelledby="start-h">
      <h2 className="h2" id="start-h">Start your catalog</h2>
      <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
        <li>
          <strong>Connect Metron{status.sources.comicvine ? " and Comic Vine" : ""}.</strong>{" "}
          {keys ? <span className="muted">Metron is connected{status.sources.comicvine ? ", and so is Comic Vine." : ". Add COMICVINE_API_KEY for first appearances, deaths and rosters."}</span>
            : <span className="muted">Add your keys to <code>backend/.env</code> (see <code>.env.example</code>) and restart the server.</span>}
        </li>
        <li><strong>Sync what you read.</strong> <span className="muted">Search Metron for a series, event or character and add it.</span></li>
        <li><strong>Bring your own comics.</strong> <span className="muted">Import CBZ, CBR, CB7, PDF or EPUB files, or connect an OPDS server.</span></li>
      </ol>
      <div className="row">
        <Link className="btn" href="/curate"><I.Plus />Add from Metron</Link>
        <Link className="btn secondary" href="/library"><I.Upload />Import comics</Link>
      </div>
    </section>
  );
}

/** First run on a phone, or the server is off: ask where it is, right on the home screen. */
function ConnectCard({ retry }: { retry: () => void }) {
  const [address, setAddress] = useState(() => serverUrl());
  const [checking, setChecking] = useState(false);
  return (
    <div className="stack-lg">
      <header className="pagehead" style={{ marginBottom: 0 }}>
        <span className="eyebrow">Not connected</span>
        <h1 className="title">Connect to your server</h1>
      </header>
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        setServerUrl(address.trim() === defaultServer() ? null : address.trim());
        setChecking(true);
        await retry();
        setChecking(false);
      }}>
        <p className="small" style={{ margin: 0 }}>
          ComixCenter runs on your computer. Start it with <code>start-server.bat</code>, then enter the address it prints
          (it looks like <code>http://192.168.1.20:8000</code>). Your phone needs to be on the same Wi-Fi.
        </p>
        <label className="label">Server address
          <input className="input" type="url" inputMode="url" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://192.168.1.20:8000" />
        </label>
        <div className="row">
          <button className="btn" disabled={checking}>{checking ? "Connecting…" : "Connect"}</button>
          <Link className="btn secondary" href="/library"><I.Book />Read saved comics</Link>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Trying {serverUrl()}.</p>
      </form>
    </div>
  );
}
