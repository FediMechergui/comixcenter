"use client";
import Link from "next/link";
import { cancelDownload, dismissDownload, hideDownloadNotice, isDownloading, startDownload, useDownloads, type DownloadJob } from "@/lib/downloads";
import { useState } from "react";

const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function status(job: DownloadJob) {
  if (job.phase === "downloading") return `${size(job.received)}${job.total ? ` of ${size(job.total)}` : " downloaded"}`;
  if (job.phase === "importing") return `Saving pages ${job.pages || 0} of ${job.pageTotal || "..."}`;
  return { cancelling: "Cancelling...", saved: "Saved for offline reading", cancelled: "Cancelled", interrupted: "Interrupted when the app closed. Retry to start again.", failed: job.error || "The download failed" }[job.phase];
}
export function DownloadsPanel() {
  const jobs = useDownloads(), [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  if (!jobs.length) return null;
  const busy = jobs.some(isDownloading);
  return <section className="stack downloads-panel" aria-label="Downloads"><h2 className="h2">Downloads</h2><p className="small muted">Direct comic files up to 64 MB. Keep the app open; you can browse other screens while saving. Interrupted transfers can be restarted.</p>
    {(showHistory ? jobs : jobs.slice(0,1)).map((job) => <div key={job.id} className="notice download-job" data-phase={job.phase}><strong>{job.title}</strong><p className="small" role="status">{status(job)}</p>
      {isDownloading(job) && <progress aria-label={`Progress for ${job.title}`} max={job.phase === "importing" ? job.pageTotal || 1 : job.total || undefined} value={job.phase === "importing" ? job.pages : job.total ? job.received : undefined} />}
      <div className="row">{isDownloading(job) ? <button className="btn secondary small" disabled={job.phase === "cancelling"} onClick={() => cancelDownload(job.id)}>Cancel download</button> : <>
        {job.fileId && job.phase === "saved" && <Link className="btn small" href={`/read?file=${job.fileId}`}>Read saved comic</Link>}
        {["failed","cancelled","interrupted"].includes(job.phase) && <button className="btn secondary small" disabled={busy} onClick={() => { try { setError(""); startDownload(job.feedId, job.href, job.title); dismissDownload(job.id); } catch (e) { setError((e as Error).message); } }}>Retry download</button>}
        <button className="btn ghost small" onClick={() => dismissDownload(job.id)}>Dismiss</button>
      </>}</div>
    </div>)}{jobs.length > 1 && <button className="btn ghost small" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>{showHistory ? "Hide earlier downloads" : `Show ${jobs.length-1} earlier downloads`}</button>}{error && <p role="alert">{error}</p>}
  </section>;
}
export function DownloadNotice() {
  const jobs = useDownloads();
  const job = jobs.find(isDownloading) || (jobs[0]?.noticeHidden ? null : jobs[0]);
  return job ? <aside className="download-notice" aria-label="Download status"><div><strong>{job.title}</strong><span className="small" role="status">{status(job)}</span></div><Link className="text-link" href="/library">Downloads</Link>{isDownloading(job) ? <button className="btn ghost small" disabled={job.phase === "cancelling"} onClick={() => cancelDownload(job.id)}>Cancel</button> : <button className="btn ghost small" onClick={() => hideDownloadNotice(job.id)}>Dismiss</button>}</aside> : null;
}
