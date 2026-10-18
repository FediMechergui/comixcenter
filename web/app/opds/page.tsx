"use client";
import { FeedEntry } from "@/components/feed";
import { useState } from "react";
import * as I from "@/components/icons";
import { Empty, ErrorBox, Loading, PageHead, Section, useAction } from "@/components/ui";
import { api, qs, refresh, useApi } from "@/lib/api";
import type { OpdsFeedPage } from "@/lib/types";

interface Feed { id: number; name: string; url: string; username: string | null; has_password: boolean; builtin: boolean }

export default function OpdsPage() {
  const feeds = useApi<Feed[]>("/api/opds");
  const [open, setOpen] = useState<{ feed: Feed; url: string | null } | null>(null);
  return (
    <>
      <PageHead eyebrow="Library" title="OPDS servers" crumbs={[{ href: "/library", label: "Library" }, { label: "OPDS" }]}>
        <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>Connect a comic server you run or have access to (Komga, Kavita, Calibre-Web, Ubooquity) and import books from it.</p>
      </PageHead>
      <div className="stack-lg">
        {feeds.error && <ErrorBox error={feeds.error} retry={() => feeds.mutate()} />}
        {!open && <AddFeed />}
        {feeds.data && !open && (
          <>
            {feeds.data.some((f) => f.builtin) && (
              <Section title="Built in">
                <div className="list">
                  {feeds.data.filter((f) => f.builtin).map((f) => <FeedRow key={f.id} feed={f} onOpen={() => setOpen({ feed: f, url: null })} />)}
                </div>
              </Section>
            )}
            <Section title="Connected">
              {feeds.data.some((f) => !f.builtin)
                ? <div className="list">
                    {feeds.data.filter((f) => !f.builtin).map((f) => <FeedRow key={f.id} feed={f} onOpen={() => setOpen({ feed: f, url: null })} />)}
                  </div>
                : <Empty title="No servers connected">Add your server&rsquo;s OPDS address, for Komga that&rsquo;s usually <code>/opds/v1.2/catalog</code>.</Empty>}
            </Section>
          </>
        )}
        {open && <FeedBrowser feed={open.feed} url={open.url} onNavigate={(url) => setOpen({ ...open, url })} onClose={() => setOpen(null)} />}
      </div>
    </>
  );
}

function FeedRow({ feed, onOpen }: { feed: Feed; onOpen: () => void }) {
  return (
    <div className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
      <button className="body" style={{ background: "none", border: 0, textAlign: "left", cursor: "pointer" }} onClick={onOpen}>
        <strong>{feed.name}</strong><span className="mono">{feed.url}</span>
      </button>
      {/* A built-in feed has no row to delete, so it offers no Remove. */}
      {!feed.builtin && <DeleteFeed id={feed.id} />}
    </div>
  );
}

function DeleteFeed({ id }: { id: number }) {
  const { run, busy } = useAction();
  return <button className="btn ghost small" disabled={busy} onClick={() => run(() => api.del(`/api/opds/${id}`), "Server removed").then(() => refresh("/api/opds"))}><I.X />Remove</button>;
}

function AddFeed() {
  const [form, setForm] = useState({ name: "", url: "", username: "", password: "" });
  const { run, busy } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      run(() => api.post("/api/opds", form), "Server connected").then((r) => { if (r) { setForm({ name: "", url: "", username: "", password: "" }); refresh("/api/opds"); } });
    }}>
      <strong className="h3">Connect a server</strong>
      <div className="grid-cards">
        <label className="label">Name<input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Komga" /></label>
        <label className="label">OPDS address<input className="input" required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://192.168.1.20:25600/opds/v1.2/catalog" /></label>
        <label className="label">Username (optional)<input className="input" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label className="label">Password (optional)<input className="input" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
      </div>
      <div><button className="btn" disabled={busy}>{busy ? "Checking…" : "Connect"}</button></div>
    </form>
  );
}

function FeedBrowser({ feed, url, onNavigate, onClose }: { feed: Feed; url: string | null; onNavigate: (url: string) => void; onClose: () => void }) {
  const { data, error, mutate } = useApi<OpdsFeedPage>(`/api/opds/${feed.id}/browse${qs({ url })}`);
  return (
    <Section title={data?.title || feed.name} action={<button className="btn ghost small" onClick={onClose}>Close</button>}>
      <div className="row">
        {url && <button className="btn secondary small" onClick={() => onNavigate(feed.url)}>Start</button>}
        {data?.up && data.up !== data.url && <button className="btn secondary small" onClick={() => onNavigate(data.up!)}><I.ChevronL />Up</button>}
      </div>
      {error && <ErrorBox error={error} retry={() => mutate()} />}
      {!data && !error && <Loading />}
      {data && (
        <div className="list">
          {data.entries.map((e, i) => <FeedEntry key={i} entry={e} feedId={feed.id} onOpen={onNavigate} />)}
        </div>
      )}
      {data?.next && <button className="btn secondary" onClick={() => onNavigate(data.next!)}>More<I.ChevronR /></button>}
    </Section>
  );
}
