/**
 * Matches a library file to a catalog issue, strongest evidence first (port of matching.py):
 * embedded source ids → barcode → ComicInfo series/number → the file name. Fuzzy matches above
 * AUTO_MATCH link automatically; weaker ones become candidates for the person to confirm.
 */
import { db, type Id, type Issue, type LibraryFile, type Series } from "./db";
import { normalizeIssueNumber, parseComicTitle, tokenSortRatio } from "./parsing";

export const AUTO_MATCH = 0.85;
const CANDIDATE_FLOOR = 0.55;

export interface Candidate { issue_id: Id; series_id: Id; label: string; confidence: number; cover: string | null }
export interface MatchResult { issue_id: Id | null; method: string | null; confidence: number; candidates: Candidate[] }

/** Series / number / year from a name like "Saga 054 (2018) (Digital) (Zone-Empire).cbz". */
export function guessFromFilename(name: string) {
  const stem = name.replace(/\.[A-Za-z0-9]{2,4}$/, "").replace(/_/g, " ");
  const parsed = parseComicTitle(stem);
  let series = parsed.series_name, number = parsed.issue_number;
  if (!number) {
    // Scanner style "Series 054 (2018)": a bare trailing number before the year/tags
    const m = /^(.+?)\s+(?:v\d+\s+)?(-?\d{1,4}(?:\.\d+)?)\s*(?:\(|$)/.exec(stem);
    if (m) { series = m[1].replace(/\s*\(\d{4}.*$/, "").trim(); number = normalizeIssueNumber(m[2]); }
  }
  const vol = /\bv(\d{1,2})\b/i.exec(stem);
  return { series, number, year: parsed.year, volume: parsed.volume ?? (vol ? vol[1] : null) };
}

async function byIds(ids: Record<string, number>): Promise<Issue | undefined> {
  const d = db();
  for (const [key, col] of [["metron", "metron_id"], ["comicvine", "cv_id"], ["gcd", "gcd_id"]] as const) {
    if (ids[key]) {
      const hit = await d.issues.where(col).equals(ids[key]).first();
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 1.0 when the year falls inside the run; decays with distance (a missing year is neutral). */
function yearFit(s: Series, year: number | null): number {
  if (!year) return 0.9;
  const start = s.first_cover_date ? parseInt(s.first_cover_date.slice(0, 4), 10) : s.year_began;
  if (start == null) return 0.85;
  let end = s.last_cover_date ? parseInt(s.last_cover_date.slice(0, 4), 10) : (s.year_end ?? start);
  end = Math.max(end, start);
  if (year >= start - 1 && year <= end + 1) return 1;
  return Math.max(0, 1 - Math.min(Math.abs(year - start), Math.abs(year - end)) * 0.15);
}

export async function fuzzyCandidates(seriesName: string | null | undefined, number: string | null | undefined,
                                      year: number | null, volume?: string | null, limit = 5): Promise<Candidate[]> {
  if (!seriesName) return [];
  const d = db();
  const all = await d.series.toArray();
  const hits = all.map((s) => ({ s, score: tokenSortRatio(seriesName, s.name) })).filter((h) => h.score >= 70)
    .sort((a, b) => b.score - a.score).slice(0, 25);
  const want = number ? normalizeIssueNumber(number) : null;
  const out: Candidate[] = [];
  for (const { s, score } of hits) {
    const issues = await d.issues.where("series_id").equals(s.id!).toArray();
    let target: Issue | undefined;
    if (want !== null) target = issues.find((i) => normalizeIssueNumber(i.number) === want);
    else if (issues.length === 1) target = issues[0];   // one-shots and graphic novels
    if (!target) continue;
    let conf = (score / 100) * yearFit(s, year);
    if (volume && s.volume && String(s.volume) !== String(volume)) conf *= 0.9;
    out.push({ issue_id: target.id!, series_id: s.id!, label: `${s.name} (${s.year_began ?? "?"}) #${target.number}`,
      confidence: Math.round(conf * 1000) / 1000, cover: target.image_url ?? null });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

export async function matchFile(comicinfo: Record<string, unknown>, filename: string): Promise<MatchResult> {
  const ids = (comicinfo.ids ?? {}) as Record<string, number>;
  const byId = await byIds(ids);
  if (byId) return { issue_id: byId.id!, method: "embedded-id", confidence: 1, candidates: [] };

  const gtin = String(comicinfo.GTIN ?? "").replace(/\D/g, "");
  if (gtin.length >= 10) {
    const d = db();
    const hit = (await d.issues.where("upc").equals(gtin).first()) ?? (await d.issues.where("isbn").equals(gtin).first());
    if (hit) return { issue_id: hit.id!, method: "barcode", confidence: 0.98, candidates: [] };
  }
  let candidates: Candidate[] = [];
  let method: string | null = null;
  if (comicinfo.Series) {
    const year = /^\d{4}$/.test(String(comicinfo.Year ?? "")) ? parseInt(String(comicinfo.Year), 10) : null;
    candidates = await fuzzyCandidates(String(comicinfo.Series), comicinfo.Number as string | undefined, year, comicinfo.Volume as string | undefined);
    method = "comicinfo";
  }
  if (!candidates.length || candidates[0].confidence < AUTO_MATCH) {
    const g = guessFromFilename(filename);
    const byName = await fuzzyCandidates(g.series, g.number, g.year, g.volume);
    if (byName.length && (!candidates.length || byName[0].confidence > candidates[0].confidence)) { candidates = byName; method = "filename"; }
  }
  if (candidates.length && candidates[0].confidence >= AUTO_MATCH) {
    // Refuse to auto-pick when two different issues score the same
    if (candidates.length === 1 || candidates[1].confidence < candidates[0].confidence - 0.02) {
      return { issue_id: candidates[0].issue_id, method, confidence: candidates[0].confidence, candidates };
    }
  }
  return { issue_id: null, method: null, confidence: candidates[0]?.confidence ?? 0, candidates: candidates.filter((c) => c.confidence >= CANDIDATE_FLOOR) };
}

/** Matches one file (unless manually matched); queues an online lookup when nothing fits. */
export async function applyMatch(file: LibraryFile, queueLookup = true): Promise<MatchResult> {
  const d = db();
  if (file.match_method === "manual") return { issue_id: file.issue_id ?? null, method: "manual", confidence: 1, candidates: [] };
  const result = await matchFile(file.comicinfo ?? {}, file.original_name);
  const parsed: Record<string, unknown> = { ...(file.parsed ?? {}), candidates: result.candidates };
  if (!result.issue_id && queueLookup && !parsed.lookup_queued) {
    const info = file.comicinfo ?? {};
    const name = (info.Series as string) || (parsed.series as string);
    const year = info.SeriesYear ?? info.Year ?? parsed.year;
    if (name) {
      const { enqueue, P_USER } = await import("./jobs");
      await enqueue("metron.find_series", { name, year: /^\d{4}$/.test(String(year ?? "")) ? Number(year) : null }, P_USER);
      parsed.lookup_queued = true;
    }
  }
  await d.libraryFiles.update(file.id!, { issue_id: result.issue_id, match_method: result.method, match_confidence: result.confidence, parsed });
  return result;
}

export async function rematchUnmatched(fileIds?: Id[]) {
  const d = db();
  let files = (await d.libraryFiles.toArray()).filter((f) => f.issue_id == null && f.match_method !== "manual");
  if (fileIds?.length) files = files.filter((f) => fileIds.includes(f.id!));
  let matched = 0;
  for (const f of files) if ((await applyMatch(f, false)).issue_id) matched++;
  return { checked: files.length, matched };
}
