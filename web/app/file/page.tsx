"use client";
import Link from "next/link";
import { Thumb } from "@/components/cards";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import * as I from "@/components/icons";
import { useNumberParam, withParams } from "@/components/params";
import { Picker } from "@/components/pickers";
import { ErrorBox, Facts, formatDate, Loading, PageHead, Section, useAction } from "@/components/ui";
import { api, apiUrl, refresh, useApi } from "@/lib/api";
import { removeOffline, saveOffline, savedPageCount } from "@/lib/offline";
import type { LibraryFile } from "@/lib/types";

const METHOD: Record<string, string> = {
  "embedded-id": "Matched by the Metron / Comic Vine id embedded in the file",
  barcode: "Matched by barcode", comicinfo: "Matched by the file's ComicInfo metadata",
  filename: "Matched by file name", manual: "Matched by you",
};

function FilePage() {
  const id = useNumberParam("id");
  const key = id ? `/api/library/${id}` : null;
  const { data: f, error, mutate } = useApi<LibraryFile>(key);
  const { run, busy } = useAction();
  const router = useRouter();
  const [saved, setSaved] = useState<number | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  useEffect(() => { if (f) savedPageCount(f.id, f.page_count).then(setSaved); }, [f]);
  if (error) return <ErrorBox error={error} retry={() => mutate()} />;
  if (!f) return <Loading />;
  const afterChange = () => { mutate(); refresh("/api/library", "/api/issues"); };
  const offline = saved !== null && saved >= f.page_count;

  return (
    <>
      <PageHead eyebrow={`${f.format.toUpperCase()} · ${f.managed ? "in your library" : "in a scanned folder"}`}
        title={f.issue ? `${f.issue.series_name} #${f.issue.number}` : f.name}
        crumbs={[{ href: "/library", label: "Library" }, { label: f.name }]} />
      <div className="stack-lg">
        <div className="row" style={{ alignItems: "flex-start", gap: 22 }}>
          <div style={{ width: "min(200px, 44vw)" }}><div className="cover"><img src={apiUrl(f.cover_url)} alt="" /></div></div>
          <div className="stack" style={{ flex: 1, minWidth: 240 }}>
            <Facts items={[[f.page_count, "Pages"], [`${(f.size / 1048576).toFixed(1)} MB`, "Size"], [formatDate(f.added_at, "full"), "Added"]]} />
            <div className="row">
              <Link className="btn" href={`/read?file=${f.id}`}><I.Book />{f.current_page > 0 && !f.finished ? `Continue from page ${f.current_page + 1}` : "Read"}</Link>
              <a className="btn secondary" href={apiUrl(`/api/library/${f.id}/export.pdf`)} download target="_blank" rel="noopener"><I.Download />Export PDF</a>
              <button className="btn secondary" disabled={saving !== null}
                onClick={async () => {
                  if (offline) { await removeOffline(f.id, f.page_count); setSaved(0); return; }
                  setSaving(0);
                  try { await saveOffline(f.id, f.page_count, setSaving, f.issue ? `${f.issue.series_name} #${f.issue.number}` : f.name); setSaved(f.page_count); }
                  catch (e) { alert((e as Error).message); }
                  finally { setSaving(null); }
                }}>
                <I.Offline />{saving !== null ? `Saving ${saving}/${f.page_count}` : offline ? "Remove offline copy" : "Save for offline"}
              </button>
            </div>
          </div>
        </div>

        <Section title="Catalog match">
          {f.issue ? (
            <div className="card flat stack">
              <span className="small">{METHOD[f.match_method ?? ""] ?? "Matched"}{f.match_confidence && f.match_method !== "manual" ? ` (${Math.round(f.match_confidence * 100)}% confidence)` : ""}.</span>
              <Link href={`/issue?id=${f.issue.id}`} className="h3" style={{ color: "var(--cyan-ink)" }}>{f.issue.series_name} ({f.issue.series_year}) #{f.issue.number}</Link>
              <div className="row">
                <button className="btn ghost small" disabled={busy} onClick={() => run(() => api.patch(`/api/library/${f.id}`, { issue_id: null }), "Match cleared, re-matching").then(afterChange)}>Clear and re-match</button>
              </div>
            </div>
          ) : (
            <div className="notice warn stack">
              <strong>Not matched to the catalog yet</strong>
              <span className="small">
                Read from the file: {[f.comicinfo.Series ?? f.parsed.series, f.comicinfo.Number ?? f.parsed.number, f.comicinfo.Year ?? f.parsed.year].filter(Boolean).join(" · ") || "nothing usable"}.
                {" "}If the series isn&rsquo;t in the catalog, ComixCenter looks it up on Metron and tries again.
              </span>
            </div>
          )}
          {f.candidates.length > 0 && !f.issue && (
            <div className="stack">
              <span className="eyebrow">Possible matches</span>
              <div className="list">
                {f.candidates.map((c) => (
                  <button key={c.issue_id} className="list-row" style={{ background: "none", border: 0, borderBottom: "1px solid var(--rule)", textAlign: "left", cursor: "pointer", width: "100%" }}
                    onClick={() => run(() => api.patch(`/api/library/${f.id}`, { issue_id: c.issue_id }), `Matched to ${c.label}`).then(afterChange)}>
                    <Thumb src={c.cover} />
                    <span className="body"><strong>{c.label}</strong><span className="mono">{Math.round(c.confidence * 100)}% likely</span></span>
                    <span className="btn small secondary" aria-hidden>This one</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="row">
            <Picker kind="issue" label="Match to an issue" placeholder={f.issue ? "Pick a different issue…" : "Search the catalog for the right issue…"}
              onPick={(o) => run(() => api.patch(`/api/library/${f.id}`, { issue_id: o.id }), `Matched to ${o.label}`).then(afterChange)} />
            <button className="btn secondary" disabled={busy} onClick={() => run(() => api.post(`/api/library/${f.id}/rematch`), "Re-matched").then(afterChange)}><I.Refresh />Try again</button>
          </div>
        </Section>

        <Section title="Remove">
          <div className="row">
            <button className="btn danger small" disabled={busy} onClick={() => {
              if (!confirm(f.managed ? "Delete this comic from your library? The imported copy is deleted." : "Remove from the library? The original file in your folder is kept.")) return;
              removeOffline(f.id, f.page_count);
              run(() => api.del(`/api/library/${f.id}`), "Removed from library").then(() => { refresh("/api/library"); router.push("/library"); });
            }}>Remove from library</button>
          </div>
        </Section>
      </div>
    </>
  );
}

export default withParams(FilePage);
