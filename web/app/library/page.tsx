"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Pager } from "@/components/cards";
import * as I from "@/components/icons";
import { useNumberParam, useSetParams, useStringParam, withParams } from "@/components/params";
import { Empty, ErrorBox, Loading, PageHead, plural, ProgressBar, Segmented, useAction, useToast } from "@/components/ui";
import { api, ApiError, apiUrl, qs, refresh, useApi, dataMode } from "@/lib/api";
import { offlineIndex, type OfflineEntry } from "@/lib/offline";
import type { LibraryFile, Page, Status } from "@/lib/types";

type Status_ = "all" | "reading" | "unmatched" | "finished";
const ACCEPT = ".cbz,.cbr,.cb7,.pdf,.epub,.zip,.rar,.7z";

function LibraryPage() {
  const status = (useStringParam("status") as Status_) || "all";
  const page = useNumberParam("page") ?? 1;
  const setParams = useSetParams();
  const key = `/api/library${qs({ status, page, size: 48, sort: status === "reading" ? "read" : "added" })}`;
  const { data, error, mutate } = useApi<Page<LibraryFile> & { counts: Record<string, number> }>(key, { keepPreviousData: true });
  const server = useApi<Status>("/api/status");
  const storage = useApi<{ files: number; pages: number; archive_bytes: number }>(dataMode() === "device" ? "/api/device/storage" : null);
  const cancelImport = useRef(false);
  const { run, busy } = useAction();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    let ok = 0, matched = 0;
    const failures: string[] = [];
    cancelImport.current = false;
    for (const [i, f] of Array.from(files).entries()) {
      if (cancelImport.current) break;
      if (f.size > 64 * 1024 * 1024) { failures.push(`${f.name}: exceeds the 64 MB import limit`); continue; }
      setUploading(`Importing ${i + 1} of ${files.length}: ${f.name}`);
      const form = new FormData();
      form.append("files", f, f.name);
      try {
        const r = await api.post<{ results: { ok: boolean; error?: string; name: string; file?: LibraryFile }[] }>("/api/library/upload", form);
        for (const res of r.results) {
          if (res.ok) { ok++; if (res.file?.issue) matched++; } else failures.push(`${res.name}: ${res.error}`);
        }
      } catch (e) { failures.push(`${f.name}: ${(e as Error).message}`); }
    }
    setUploading(null);
    if (input.current) input.current.value = "";
    toast(failures.length ? `Imported ${ok}; ${failures.length} failed. ${failures[0]}` : `Imported ${plural(ok, "comic")}, ${matched} matched to the catalog`);
    refresh("/api/library", "/api/status", "/api/device/storage");
  }

  return (
    <>
      <PageHead eyebrow="Your comics" title="Library">
        <p className="muted" style={{ margin: 0, maxWidth: "60ch" }}>
          Comics you own, matched to the catalog so your reading counts in every reading order.
          CBZ, CBR, CB7, PDF and EPUB.
        </p>
      </PageHead>
      <div className="stack-lg">
        <div className="row">
          <input ref={input} type="file" multiple accept={ACCEPT} disabled={!!uploading} className="visually-hidden" id="upload" onChange={(e) => upload(e.target.files)} />
          <label htmlFor="upload" className="btn" aria-disabled={!!uploading}><I.Upload />Import files</label>
          {server.data && server.data.scan_dirs.length > 0 && (
            <button className="btn secondary" disabled={busy}
              onClick={() => run(() => api.post<{ added: number; errors: unknown[] }>("/api/library/scan", {}), (r) => `Scanned your folders: ${plural(r.added, "new comic")}`).then(() => refresh("/api/library"))}>
              <I.Refresh />Scan folders
            </button>
          )}
          <Link href="/opds" className="btn secondary"><I.Link />OPDS servers</Link>
        </div>
        {storage.data && <p className="small muted">{storage.data.files} saved comics · {storage.data.pages} offline pages · {(storage.data.archive_bytes / 1024 / 1024).toFixed(1)} MB of original archives. Extracted pages use additional storage. Manage each comic from its details page.</p>}
        {uploading && <div className="notice" role="status">{uploading}<button className="btn ghost small" onClick={() => { cancelImport.current = true; }}>Stop after this file</button></div>}

        <Segmented label="Show" value={status} onChange={(v) => setParams({ status: v === "all" ? null : v, page: null })} options={[
          { value: "all", label: `All${data ? ` ${data.counts.all}` : ""}` }, { value: "reading", label: "Reading" },
          { value: "unmatched", label: `Needs a match${data?.counts.unmatched ? ` ${data.counts.unmatched}` : ""}` }, { value: "finished", label: "Finished" },
        ]} />

        {error && (error instanceof ApiError && error.status === 0 ? <OfflineShelf retry={() => mutate()} /> : <ErrorBox error={error} retry={() => mutate()} />)}
        {!data && !error && <Loading lines={6} />}
        {data && data.items.length === 0 && (
          status === "all"
            ? <Empty title="Your library is empty" action={<label htmlFor="upload" className="btn"><I.Upload />Import files</label>}>
                Import comics you own. Files tagged with ComicInfo or MetronInfo match instantly; others are matched by file name.
              </Empty>
            : <Empty title="Nothing here">No comics in this view.</Empty>
        )}
        {data && data.items.length > 0 && (
          <>
            <div className="grid-covers">
              {data.items.map((f) => (
                <div key={f.id} className="issue-tile">
                  <Link href={`/read?file=${f.id}`} className="card-link" aria-label={`Read ${f.issue ? `${f.issue.series_name} #${f.issue.number}` : f.name}`}>
                    <div className="cover">
                      <img src={apiUrl(f.cover_url)} alt="" loading="lazy" />
                      {f.finished && <span className="readmark" title="Finished"><I.Check /></span>}
                      {!f.issue && <span className="owned" style={{ background: "var(--magenta)" }}>Needs a match</span>}
                    </div>
                  </Link>
                  <Link href={`/file?id=${f.id}`} className="meta">
                    <strong>{f.issue ? `${f.issue.series_name} #${f.issue.number}` : f.name}</strong>
                    <span className="mono">{f.format.toUpperCase()} · {f.page_count} pp</span>
                    {f.current_page > 0 && !f.finished && <ProgressBar read={f.current_page + 1} total={f.page_count} thin />}
                  </Link>
                </div>
              ))}
            </div>
            <Pager page={data.page} size={data.size} total={data.total} onPage={(p) => setParams({ page: p })} />
          </>
        )}
      </div>
    </>
  );
}

/** Shown when the server can't be reached: the comics saved on this device still open. */
function OfflineShelf({ retry }: { retry: () => void }) {
  const [saved, setSaved] = useState<OfflineEntry[]>([]);
  useEffect(() => setSaved(offlineIndex()), []);
  return (
    <div className="stack">
      <div className="notice warn" role="status">
        <strong>You&rsquo;re offline</strong>
        <p className="small" style={{ margin: "6px 0 10px" }}>The ComixCenter server can&rsquo;t be reached. Comics you saved for offline reading still open.</p>
        <button className="btn small secondary" onClick={retry}>Try again</button>
      </div>
      {saved.length === 0
        ? <Empty title="Nothing saved on this device">Open a comic&rsquo;s page and choose Save for offline while you&rsquo;re connected.</Empty>
        : (
          <div className="list">
            {saved.map((e) => (
              <Link key={e.id} href={`/read?file=${e.id}`} className="list-row" style={{ gridTemplateColumns: "1fr auto" }}>
                <span className="body"><strong>{e.title}</strong><span className="mono">{e.pages} pages · saved for offline</span></span>
                <I.Book />
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}

export default withParams(LibraryPage);
