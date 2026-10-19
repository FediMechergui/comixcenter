/** Personal recovery file: catalog + progress, never accounts, source cookies or comic bytes. */
import { db, type Issue, type Series } from "./db";
import { SNAPSHOT_TABLES, type Snapshot, exportSnapshot } from "./snapshot";
import { startWorker, stopWorker, workerStatus } from "./jobs";

export const BACKUP_FORMAT = "comixcenter-personal-backup";
interface SavedFile { sha256: string; name: string; current_page: number; issue_id?: number | null; finished_at?: string | null; last_read_at?: string | null }
export interface PersonalBackup {
  format: typeof BACKUP_FORMAT; version: 1; created_at: string; catalog: Snapshot;
  readStatus: { issue_id: number; read_at: string }[];
  library: SavedFile[]; preferences: Record<string, string>;
}
const permitted = (key: string) => /^comix\.guide\.[a-z0-9-]+$/.test(key) || ["comix.reading-history.v1", "comix.online-mode", "comix.reader", "comix.theme"].includes(key);

export async function exportPersonalBackup(): Promise<PersonalBackup> {
  const preferences: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (permitted(key)) preferences[key] = localStorage.getItem(key)!;
  }
  return db().transaction("r", [...SNAPSHOT_TABLES.map((n) => db().table(n)), db().readStatus, db().libraryFiles, db().settings], async () => {
    const pending = (await db().settings.get("recovered-library-progress"))?.value;
    const manifest = new Map<string, SavedFile>((Array.isArray(pending) ? pending : []).map((f: SavedFile) => [f.sha256, f]));
    for (const f of await db().libraryFiles.toArray()) manifest.set(f.sha256, { sha256: f.sha256, name: f.original_name, current_page: f.current_page, issue_id: f.issue_id, finished_at: f.finished_at, last_read_at: f.last_read_at });
    return {
    format: BACKUP_FORMAT, version: 1, created_at: new Date().toISOString(), catalog: await exportSnapshot(),
    readStatus: await db().readStatus.toArray(),
    library: [...manifest.values()],
    preferences,
  }; });
}

export function validateBackup(value: unknown): PersonalBackup {
  const b = value as PersonalBackup;
  const fail = () => { throw new Error("This is not a supported ComixCenter personal backup."); };
  if (!b || b.format !== BACKUP_FORMAT || b.version !== 1 || !b.catalog || b.catalog.version !== 1 || !b.catalog.tables || !Array.isArray(b.readStatus) || !Array.isArray(b.library) || !b.preferences || typeof b.preferences !== "object") fail();
  if (typeof b.created_at !== "string" || !Number.isFinite(Date.parse(b.created_at)) || !b.catalog.counts || typeof b.catalog.counts !== "object") fail();
  for (const [name, rows] of Object.entries(b.catalog.tables)) {
    if (!(SNAPSHOT_TABLES as readonly string[]).includes(name) || !Array.isArray(rows) || rows.length > 250_000 || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) fail();
  }
  for (const [key, value] of Object.entries(b.preferences)) {
    if (!permitted(key) || typeof value !== "string" || value.length > 2_000_000) fail();
    if (key.includes("guide.") && (!Array.isArray(JSON.parse(value)) || JSON.parse(value).some((n: unknown) => !Number.isInteger(n) || Number(n) < 0))) fail();
    if (key === "comix.reading-history.v1" && !Array.isArray(JSON.parse(value))) fail();
  }
  if (b.readStatus.some((r) => !Number.isSafeInteger(r.issue_id) || typeof r.read_at !== "string")) fail();
  if (b.library.some((f) => !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.current_page) || f.current_page < 0)) fail();
  return b;
}

function issueKey(issue: Issue, series: Series | undefined) {
  if (issue.metron_id) return `metron:${issue.metron_id}`;
  if (issue.cv_id) return `cv:${issue.cv_id}`;
  return `${series?.name.toLowerCase()}|${series?.year_began}|${issue.number}`;
}

/** Called only after the UI previews replacement. All catalog changes roll back on any failure. */
export async function restorePersonalBackup(value: unknown) {
  const b = validateBackup(value), d = db();
  const worker = workerStatus();
  if (worker.current.length) throw new Error("A catalog sync is still running. Wait for it to finish before restoring.");
  if (worker.running) stopWorker();
  const previous = new Map<string, string | null>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (permitted(key)) previous.set(key, localStorage.getItem(key));
  }
  for (const key of Object.keys(b.preferences)) if (!previous.has(key)) previous.set(key, null);
  try {
    return await d.transaction("rw", [...SNAPSHOT_TABLES.map((n) => d.table(n)), d.readStatus, d.libraryFiles, d.settings, d.jobs], async () => {
      const series = new Map((await d.series.toArray()).map((s) => [s.id!, s]));
      const oldIssues = new Map((await d.issues.toArray()).map((i) => [i.id!, issueKey(i, series.get(i.series_id))]));
      const files = await d.libraryFiles.toArray();
      for (const name of SNAPSHOT_TABLES) {
        await d.table(name).clear();
        if (b.catalog.tables[name]?.length) await d.table(name).bulkPut(b.catalog.tables[name]!);
      }
      const newSeries = new Map((await d.series.toArray()).map((s) => [s.id!, s]));
      const newIssues = new Map((await d.issues.toArray()).map((i) => [issueKey(i, newSeries.get(i.series_id)), i.id!]));
      const ids = new Set(newIssues.values());
      await d.readStatus.clear();
      await d.readStatus.bulkPut(b.readStatus.filter((r) => ids.has(r.issue_id)));
      await d.jobs.clear();
      await d.settings.put({ key: "recovered-library-progress", value: b.library });
      const saved = new Map(b.library.map((f) => [f.sha256, f]));
      let restoredFiles = 0;
      for (const file of files) {
        const progress = saved.get(file.sha256);
        const issueId = progress?.issue_id != null && ids.has(progress.issue_id) ? progress.issue_id : newIssues.get(oldIssues.get(file.issue_id!) || "") ?? null;
        await d.libraryFiles.update(file.id!, {
          issue_id: issueId,
          ...(progress ? { current_page: Math.min(progress.current_page, Math.max(0, file.page_count - 1)), finished_at: progress.finished_at, last_read_at: progress.last_read_at } : {}),
        });
        if (progress) restoredFiles++;
      }
      for (const key of previous.keys()) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(b.preferences)) localStorage.setItem(key, value);
      return { restoredFiles, missingFiles: b.library.filter((f) => !files.some((existing) => existing.sha256 === f.sha256)).length };
    });
  } catch (error) {
    for (const [key, value] of previous) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
    throw error;
  } finally { if (worker.running) startWorker(); }
}
