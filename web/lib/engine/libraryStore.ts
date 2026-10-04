/**
 * The phone's comic library: import (unpack every page once into app storage), file cards for
 * the UI, page URLs, panels, reading position and PDF export. Formats come from ./library.
 */
import { db, nowIso, type Id, type LibraryFile } from "./db";
import { detectPanelsInImage, imagesToPdf, openComic, readEmbeddedMetadata, DEFAULT_ASSET_URLS } from "./library";
import { applyMatch, guessFromFilename } from "./matching";
import { fileStore } from "./storage";
import { issueCards } from "./services/catalog";

export class ImportError extends Error {}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp", "image/tiff": "tif", "image/avif": "avif",
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const pagePath = (f: LibraryFile, i: number) => `${f.dir}/p${String(i + 1).padStart(5, "0")}.${f.page_ext[i] ?? "jpg"}`;

export type ImportProgress = (done: number, total: number) => void;

/** Adds a comic to the library and matches it to the catalog. Returns [file, created]. */
export async function importComic(bytes: Uint8Array, originalName: string, progress?: ImportProgress, opdsFeedId?: Id | null): Promise<[LibraryFile, boolean]> {
  const d = db();
  const digest = await sha256(bytes);
  const existing = await d.libraryFiles.where("sha256").equals(digest).first();
  if (existing) return [existing, false];
  let source;
  try {
    source = await openComic(bytes, DEFAULT_ASSET_URLS);
  } catch (e) {
    throw new ImportError(`${originalName}: ${(e as Error).message}`);
  }
  const dir = `library/${digest.slice(0, 2)}/${digest}`;
  const store = fileStore();
  try {
    if (source.pageCount === 0) throw new ImportError(`${originalName} contains no pages`);
    const pageExt: string[] = [];
    for (let i = 0; i < source.pageCount; i++) {
      const page = await source.getPage(i);
      const ext = EXT[page.mime] ?? "jpg";
      pageExt.push(ext);
      await store.write(`${dir}/p${String(i + 1).padStart(5, "0")}.${ext}`, page.data);
      progress?.(i + 1, source.pageCount);
    }
    if (source.format === "pdf") await store.write(`${dir}/original.pdf`, bytes);
    const info = readEmbeddedMetadata(await source.metadataFiles());
    const file: LibraryFile = {
      dir, original_name: originalName, format: source.format, size: bytes.byteLength, sha256: digest, page_count: source.pageCount,
      added_at: nowIso(), current_page: 0, comicinfo: Object.keys(info).length ? info : null,
      parsed: guessFromFilename(originalName) as unknown as Record<string, unknown>, page_ext: pageExt, opds_feed_id: opdsFeedId ?? null,
    };
    file.id = await d.libraryFiles.add(file);
    await applyMatch(file);
    return [(await d.libraryFiles.get(file.id))!, true];
  } catch (e) {
    await store.removeDir(dir);
    throw e instanceof ImportError ? e : new ImportError(`${originalName}: ${(e as Error).message}`);
  } finally {
    source.close();
  }
}

export async function pageUrls(f: LibraryFile): Promise<string[]> {
  const store = fileStore();
  return Promise.all(Array.from({ length: f.page_count }, (_, i) => store.url(pagePath(f, i))));
}

export async function readPage(f: LibraryFile, index: number): Promise<{ data: Uint8Array; mime: string }> {
  const ext = f.page_ext[index] ?? "jpg";
  const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "image/jpeg";
  return { data: await fileStore().read(pagePath(f, index)), mime };
}

export async function fileCard(f: LibraryFile) {
  const issue = f.issue_id ? await db().issues.get(f.issue_id) : undefined;
  const cover = f.page_count ? await fileStore().url(pagePath(f, 0)) : "";
  const parsed = f.parsed ?? {};
  const info = f.comicinfo ?? {};
  return {
    id: f.id!, name: f.original_name, format: f.format, size: f.size, page_count: f.page_count, current_page: f.current_page,
    finished: !!f.finished_at, added_at: f.added_at, last_read_at: f.last_read_at ?? null, managed: true,
    match_method: f.match_method ?? null, match_confidence: f.match_confidence ?? null,
    issue: issue ? (await issueCards([issue]))[0] : null,
    candidates: (parsed.candidates as unknown[]) ?? [],
    parsed: Object.fromEntries(Object.entries(parsed).filter(([k]) => ["series", "number", "year", "volume"].includes(k))),
    comicinfo: Object.fromEntries(Object.entries(info).filter(([k]) => ["Series", "Number", "Year", "Volume", "Title", "ids"].includes(k))),
    cover_url: cover,
    page_urls: await pageUrls(f),
  };
}

export async function listLibrary(f: { q?: string | null; status?: string; sort?: string; page?: number; size?: number }) {
  const d = db();
  const page = f.page ?? 1, size = f.size ?? 60;
  let files = await d.libraryFiles.toArray();
  const counts = { all: files.length, unmatched: files.filter((x) => x.issue_id == null).length };
  if (f.q) {
    const l = f.q.toLowerCase();
    const seriesHit = new Set((await d.series.filter((s) => s.name.toLowerCase().includes(l)).primaryKeys()));
    const issueHit = new Set((await d.issues.filter((i) => seriesHit.has(i.series_id)).primaryKeys()));
    files = files.filter((x) => x.original_name.toLowerCase().includes(l) || (x.issue_id != null && issueHit.has(x.issue_id)));
  }
  if (f.status === "matched") files = files.filter((x) => x.issue_id != null);
  else if (f.status === "unmatched") files = files.filter((x) => x.issue_id == null);
  else if (f.status === "reading") files = files.filter((x) => x.current_page > 0 && !x.finished_at);
  else if (f.status === "finished") files = files.filter((x) => !!x.finished_at);
  if (f.sort === "name") files.sort((a, b) => a.original_name.localeCompare(b.original_name));
  else if (f.sort === "read") files.sort((a, b) => (b.last_read_at ?? "").localeCompare(a.last_read_at ?? ""));
  else files.sort((a, b) => b.added_at.localeCompare(a.added_at));
  const slice = files.slice((page - 1) * size, page * size);
  return { items: await Promise.all(slice.map(fileCard)), total: files.length, page, size, counts };
}

/** Saves the position; reaching the last page marks the linked issue read. */
export async function recordPosition(f: LibraryFile, pageIndex: number) {
  const d = db();
  const current = Math.max(0, Math.min(pageIndex, Math.max(f.page_count - 1, 0)));
  const now = nowIso();
  const finished = f.page_count > 0 && current >= f.page_count - 1;
  await d.libraryFiles.update(f.id!, { current_page: current, last_read_at: now, ...(finished && !f.finished_at ? { finished_at: now } : {}) });
  if (finished && f.issue_id && !(await d.readStatus.get(f.issue_id))) await d.readStatus.put({ issue_id: f.issue_id, read_at: now });
  return { current_page: current, finished, issue_id: f.issue_id ?? null };
}

export async function pagePanels(f: LibraryFile, index: number, rtl: boolean) {
  const d = db();
  let cached = await d.pagePanels.get([f.id!, index]);
  if (!cached) {
    const { data } = await readPage(f, index);
    const result = await detectPanelsInImage(data, false);
    cached = { file_id: f.id!, page_index: index, width: result.width, height: result.height, panels: result.panels };
    await d.pagePanels.put(cached);
  }
  let panels = cached.panels;
  if (rtl) {
    // Re-sort right-to-left within rows: panels whose tops are close share a row
    const rows: number[][][] = [];
    for (const p of [...panels].sort((a, b) => a[1] - b[1])) {
      if (rows.length && Math.abs(rows[rows.length - 1][0][1] - p[1]) < 0.05) rows[rows.length - 1].push(p);
      else rows.push([p]);
    }
    panels = rows.flatMap((r) => r.sort((a, b) => b[0] - a[0]));
  }
  return { width: cached.width, height: cached.height, panels };
}

/** PDF of a file you own: the original for PDFs, otherwise the pages (JPEGs embedded losslessly). */
export async function exportPdfBytes(f: LibraryFile): Promise<Uint8Array> {
  if (f.format === "pdf") return fileStore().read(`${f.dir}/original.pdf`);
  const pages = [];
  for (let i = 0; i < f.page_count; i++) pages.push(await readPage(f, i));
  return imagesToPdf(pages);
}

export async function removeFile(f: LibraryFile) {
  const d = db();
  await fileStore().removeDir(f.dir);
  await d.pagePanels.where("file_id").equals(f.id!).delete();
  await d.libraryFiles.delete(f.id!);
}
