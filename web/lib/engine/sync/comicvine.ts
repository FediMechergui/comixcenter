/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Comic Vine enrichment (port of backend/comix/ingest/comicvine_sync.py): real names, aliases,
 * first appearances, deaths, team rosters, disbandings, arc text. Objects use simyan's attribute
 * names (real_name, first_issue, deaths, members, issues_disbanded_in, ...).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotFoundError } from "../contracts";
import { db, nowIso, type Id, type Identity, type Issue, type Series } from "../db";
import { defaultProcess, foldAccents, normalizeIssueNumber, norm, stripHtml, tokenSortRatio, words } from "../parsing";
import { assignSeriesUniverses } from "../taxonomy";
import {
  addAffiliation, addAppearance, addCredit, addTeamAppearance, ensureArc, ensureCreator, ensureIdentity, ensureTeam,
  refreshSeriesSpan, upsertIssue, upsertPublisher, upsertSeries,
} from "./upserts";

export interface ComicVineApi {
  getCharacter(id: number): Promise<any>;
  getIssue(id: number): Promise<any>;
  getTeam(id: number): Promise<any>;
  getStoryArc(id: number): Promise<any>;
  getVolume(id: number): Promise<any>;
  searchVolumes(query: string, maxResults?: number): Promise<any[]>;
  volumeIssues(volumeId: number): Promise<any[]>;
}

/** GCD serves its cover scans only on its own site (files*.comics.org answers apps with 403). */
export function isUnservableCover(url: string | null | undefined): boolean {
  return !!url && /^https?:\/\/files\d*\.comics\.org\//i.test(url);
}

const bare = (name: string) => defaultProcess(foldAccents(name)).replace(/^the /, "");

/** The Comic Vine volume for a series: same title, then nearest start year, publisher and length. */
export function pickVolume(hits: any[], name: string, year: number | null | undefined, publisher: string | null | undefined, issueCount: number | null | undefined) {
  const score = (v: any) => {
    const title = tokenSortRatio(bare(name), bare(v.name ?? ""));
    if (title < 85) return -1;
    let s = title;
    if (year && v.start_year) s -= Math.min(Math.abs(year - v.start_year), 10) * 4;
    const vp = norm(v.publisher?.name);
    if (publisher && vp) s += vp.includes(norm(publisher)) || norm(publisher).includes(vp) ? 15 : -10;
    if (issueCount && v.issue_count) s -= Math.min(Math.abs(issueCount - v.issue_count) / Math.max(issueCount, 1), 1) * 10;
    return s;
  };
  const ranked = hits.map((v) => [score(v), v] as const).filter(([s]) => s >= 70).sort((a, b) => b[0] - a[0]);
  return ranked[0]?.[1] ?? null;
}

/** Comic Vine description text without its cover-credit tables ("List of covers and their creators"). */
export function cvText(html: string | null | undefined): string | null {
  if (!html) return null;
  const cut = html.search(/<h[1-6][^>]*>\s*(list of covers|covers?)/i);
  return stripHtml((cut >= 0 ? html.slice(0, cut) : html).replace(/<table[\s\S]*?<\/table>/gi, " "));
}

const coverOf = (image: any): string | null => image?.medium_url || image?.super_url || image?.original_url || null;

/**
 * Covers for a series from Comic Vine (one search plus one request per 100 issues). Also records
 * the Comic Vine ids, which later enrichment uses. Covers already from Metron are kept.
 */
export async function syncSeriesCovers(cv: ComicVineApi, seriesId: Id) {
  const d = db();
  const series = await d.series.get(seriesId);
  if (!series) throw new NotFoundError(`Series ${seriesId} not found`);
  let volumeId = series.cv_id ?? null;
  if (!volumeId) {
    const publisher = series.publisher_id ? (await d.publishers.get(series.publisher_id))?.name : null;
    const hit = pickVolume(await cv.searchVolumes(series.name, 20), series.name, series.year_began, publisher, series.issue_count);
    if (!hit) return { found: false };
    volumeId = hit.id as number;
    await d.series.update(seriesId, { cv_id: volumeId });
  }
  const byNumber = new Map<string, any>();
  for (const i of await cv.volumeIssues(volumeId)) {
    const key = normalizeIssueNumber(i.number) ?? "";
    if (key && !byNumber.has(key)) byNumber.set(key, i);
  }
  const issues = await d.issues.where("series_id").equals(seriesId).toArray();
  let covered = 0;
  for (const issue of issues) {
    const hit = byNumber.get(normalizeIssueNumber(issue.number) ?? "");
    if (!hit) continue;
    const patch: Partial<Issue> = {};
    const url = coverOf(hit.image);
    if (url && (!issue.image_url || isUnservableCover(issue.image_url))) patch.image_url = url;
    if (!issue.cv_id) patch.cv_id = hit.id;
    if (!issue.cover_date && hit.cover_date) patch.cover_date = hit.cover_date;
    if (Object.keys(patch).length) await d.issues.update(issue.id!, patch);
    if (patch.image_url) covered++;
  }
  const first = (await d.issues.where("series_id").equals(seriesId).toArray()).filter((i) => i.image_url && !isUnservableCover(i.image_url))
    .sort((a, b) => a.number_sort - b.number_sort)[0];
  if (first && (!series.image_url || isUnservableCover(series.image_url))) await d.series.update(seriesId, { image_url: first.image_url });
  return { cv_volume_id: volumeId, covered, issues: issues.length };
}

async function localIssue(cvIssueId: number | null | undefined) {
  return cvIssueId ? db().issues.where("cv_id").equals(cvIssueId).first() : undefined;
}

/** "Amazing Fantasy #15 (1962)" for a Comic Vine issue reference (fetches the issue for its volume). */
async function issueLabel(cv: ComicVineApi, ref: any): Promise<string> {
  let number = ref.number;
  try {
    const full = await cv.getIssue(ref.id);
    const volume = full?.volume?.name;
    const year = full?.cover_date ? String(full.cover_date).slice(0, 4) : null;
    number = number ?? full?.number;
    if (volume) return `${volume} #${number}${year ? ` (${year})` : ""}`;
  } catch { /* fall back to the reference's own name */ }
  return `${ref.name ?? "Issue"}${number ? ` #${number}` : ""}`;
}

async function upsertEvent(identityId: Id, kind: "first_appearance" | "death", cvIssueId: number, label: string | null) {
  const d = db();
  const existing = (await d.characterEvents.where("identity_id").equals(identityId).toArray())
    .find((e) => e.kind === kind && e.cv_issue_id === cvIssueId);
  const local = await localIssue(cvIssueId);
  if (existing) {
    await d.characterEvents.update(existing.id!, { issue_id: local?.id ?? existing.issue_id ?? null, issue_text: label ?? existing.issue_text ?? null });
    return { ...existing, issue_id: local?.id ?? existing.issue_id };
  }
  const id = await d.characterEvents.add({ identity_id: identityId, kind, cv_issue_id: cvIssueId, issue_id: local?.id ?? null,
    issue_text: label, source: "comicvine" });
  return { id, issue_id: local?.id ?? null };
}

export async function enrichIdentity(cv: ComicVineApi, identityId: Id) {
  const d = db();
  const identity = await d.identities.get(identityId);
  if (!identity?.cv_id) return { skipped: "no Comic Vine id" };
  const c = await cv.getCharacter(identity.cv_id);
  const patch: Partial<Identity> = { real_name: c.real_name || identity.real_name || null };
  if (c.aliases) {
    const extra = String(c.aliases).split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
    patch.aliases = [...new Set([...(identity.aliases ?? []), ...extra])];
  }
  if (!identity.description) patch.description = c.summary || stripHtml(c.description);
  if (!identity.image_url && c.image?.original_url) patch.image_url = String(c.image.original_url);
  // A plain record like "Spider-Man" whose real name is Peter Parker: show the person
  const character = await d.characters.get(identity.character_id);
  if (identity.display_name === identity.name && patch.real_name && character?.name === identity.name) patch.display_name = patch.real_name;

  const result: Record<string, unknown> = { identity_id: identityId };
  if (c.first_issue) {
    const label = await issueLabel(cv, c.first_issue);
    const ev = await upsertEvent(identityId, "first_appearance", c.first_issue.id, label);
    patch.first_appearance_issue_id = ev.issue_id ?? identity.first_appearance_issue_id ?? null;
    patch.first_appearance_text = label;
    result.first_appearance = label;
    result.first_appearance_cv_issue_id = c.first_issue.id;
  }
  for (const death of c.deaths ?? []) await upsertEvent(identityId, "death", death.id, death.name ?? null);
  result.deaths = (c.deaths ?? []).length;
  for (const ref of c.teams ?? []) {
    const team = await d.teams.where("cv_id").equals(ref.id).first();
    if (team) await addAffiliation(identityId, team.id!, "comicvine");
  }
  const merged = { ...identity, ...patch };
  await d.identities.update(identityId, { ...patch, cv_enriched_at: nowIso(),
    words: words(merged.display_name, merged.name, merged.real_name, ...(merged.aliases ?? [])) });
  return result;
}

export async function enrichTeam(cv: ComicVineApi, teamId: Id) {
  const d = db();
  const team = await d.teams.get(teamId);
  if (!team?.cv_id) return { skipped: "no Comic Vine id" };
  const t = await cv.getTeam(team.cv_id);
  const patch: any = {};
  if (!team.description) patch.description = t.summary || stripHtml(t.description);
  if (!team.image_url && t.image?.original_url) patch.image_url = String(t.image.original_url);
  if (t.first_issue) {
    const label = await issueLabel(cv, t.first_issue);
    const local = await localIssue(t.first_issue.id);
    patch.first_appearance_issue_id = local?.id ?? team.first_appearance_issue_id ?? null;
    patch.first_appearance_text = label;
  }
  if ((t.issues_disbanded_in ?? []).length) {
    patch.disbanded_text = t.issues_disbanded_in.map((i: any) => i.name || `Issue ${i.id}`).join(", ").slice(0, 500);
  }
  let matched = 0;
  for (const ref of t.members ?? []) {
    const identity = await d.identities.where("cv_id").equals(ref.id).first();
    if (identity) { matched++; await addAffiliation(identity.id!, teamId, "comicvine"); }
  }
  await d.teams.update(teamId, { ...patch, cv_enriched_at: nowIso() });
  return { team_id: teamId, members_matched: matched, members_listed: (t.members ?? []).length };
}

export async function enrichArc(cv: ComicVineApi, arcId: Id) {
  const d = db();
  const arc = await d.arcs.get(arcId);
  if (!arc?.cv_id) return { skipped: "no Comic Vine id" };
  const a = await cv.getStoryArc(arc.cv_id);
  const patch: any = {};
  if (!arc.description) patch.description = stripHtml(a.description) || a.summary || null;
  if (!arc.image_url && a.image?.original_url) patch.image_url = String(a.image.original_url);
  if (Object.keys(patch).length) await d.arcs.update(arcId, patch);
  return { arc_id: arcId };
}

/** First appearances and deaths recorded on a single issue. */
export async function enrichIssue(cv: ComicVineApi, issueId: Id) {
  const d = db();
  const issue = await d.issues.get(issueId);
  if (!issue?.cv_id) return { skipped: "no Comic Vine id" };
  const i = await cv.getIssue(issue.cv_id);
  const series = await d.series.get(issue.series_id);
  const label = `${series?.name ?? "Issue"} #${issue.number}${issue.cover_date ? ` (${issue.cover_date.slice(0, 4)})` : ""}`;
  let firsts = 0, deaths = 0;
  for (const ref of i.first_appearance_characters ?? []) {
    const identity = await d.identities.where("cv_id").equals(ref.id).first();
    if (!identity) continue;
    await upsertEvent(identity.id!, "first_appearance", issue.cv_id, label);
    if (!identity.first_appearance_issue_id) await d.identities.update(identity.id!, { first_appearance_issue_id: issueId, first_appearance_text: label });
    firsts++;
  }
  for (const ref of i.first_appearance_teams ?? []) {
    const team = await d.teams.where("cv_id").equals(ref.id).first();
    if (team && !team.first_appearance_issue_id) await d.teams.update(team.id!, { first_appearance_issue_id: issueId, first_appearance_text: label });
  }
  for (const ref of i.deaths ?? []) {
    const identity = await d.identities.where("cv_id").equals(ref.id).first();
    if (identity) { await upsertEvent(identity.id!, "death", issue.cv_id, label); deaths++; }
  }
  await d.issues.update(issueId, { cv_enriched_at: nowIso() });
  return { issue_id: issueId, first_appearances: firsts, deaths };
}

/** Comic Vine search hits for "find online": series with their cover, publisher and length. */
export async function searchCvVolumes(cv: ComicVineApi, query: string) {
  const hits = await cv.searchVolumes(query, 20);
  const want = bare(query);
  const rank = (v: any) => { const t = bare(v.name ?? ""); return t === want ? 0 : t.startsWith(want) ? 1 : 2; };
  return hits.slice().sort((a, b) => rank(a) - rank(b) || (b.issue_count ?? 0) - (a.issue_count ?? 0)).map((v: any) => ({
    cv_id: v.id as number, name: v.name as string, year_began: v.start_year ?? null, issue_count: v.issue_count ?? 0,
    publisher: v.publisher?.name ?? null, image_url: v.image?.small_url || v.image?.thumbnail || null,
  }));
}

/**
 * A series and its issue list (numbers, titles, dates, covers) from a Comic Vine volume: the volume
 * plus one request per 100 issues. Joins a series already in the catalog under the same title, year
 * and publisher (e.g. added from GCD) instead of duplicating it.
 */
export async function syncCvSeries(cv: ComicVineApi, volumeId: number, progress?: (m: string) => void) {
  const d = db();
  const v = await cv.getVolume(volumeId);
  const publisher = await upsertPublisher({ cv_id: v.publisher?.id ?? null }, v.publisher?.name ?? null);
  let existing = await d.series.where("cv_id").equals(volumeId).first();
  if (!existing && v.start_year) {
    existing = (await d.series.where("year_began").equals(v.start_year).toArray())
      .find((s) => !s.cv_id && bare(s.name) === bare(v.name) && (!publisher || !s.publisher_id || s.publisher_id === publisher.id));
  }
  const fields = {
    name: v.name as string, year_began: v.start_year ?? null, publisher_id: publisher?.id ?? null,
    description: stripHtml(v.summary) ?? cvText(v.description)?.slice(0, 4000) ?? null, image_url: coverOf(v.image), synced_at: nowIso(),
  };
  let series: Series;
  if (existing) {
    // Keep what the catalog already has; add the Comic Vine id and fill gaps
    const patch: Partial<Series> = { cv_id: volumeId, synced_at: fields.synced_at };
    if (!existing.description && fields.description) patch.description = fields.description;
    if (fields.image_url && (!existing.image_url || isUnservableCover(existing.image_url))) patch.image_url = fields.image_url;
    if (!existing.publisher_id && fields.publisher_id) patch.publisher_id = fields.publisher_id;
    await d.series.update(existing.id!, patch);
    series = { ...existing, ...patch };
  } else {
    series = await upsertSeries({ cv_id: volumeId }, fields);
  }
  const local = await d.issues.where("series_id").equals(series.id!).toArray();
  const byNumber = new Map(local.map((i) => [normalizeIssueNumber(i.number) ?? i.number, i]));
  const seen = new Set<string>();
  let count = 0;
  for (const i of await cv.volumeIssues(volumeId)) {
    const number = (i.number ?? "").trim() || "?";
    const key = normalizeIssueNumber(number) ?? number;
    if (seen.has(key)) continue;
    seen.add(key);
    const patch: Partial<Issue> = { cv_id: i.id };
    const cover = coverOf(i.image);
    const mine = byNumber.get(key);
    if (cover && (!mine?.image_url || isUnservableCover(mine.image_url))) patch.image_url = cover;
    if (i.name && !mine?.title) patch.title = i.name;
    if (i.cover_date && !mine?.cover_date) patch.cover_date = i.cover_date;
    if (i.store_date && !mine?.store_date) patch.store_date = i.store_date;
    if (mine) await d.issues.update(mine.id!, patch);
    else await upsertIssue({ cv_id: i.id }, series.id!, { number, ...patch, synced_at: nowIso() });
    count++;
  }
  await d.series.update(series.id!, { issue_count: Math.max(count, series.issue_count ?? 0) });
  await refreshSeriesSpan(series.id!);
  const universes = await assignSeriesUniverses(series.id!);
  progress?.(`${v.name}: ${count} issues`);
  return { series_id: series.id!, issues: count, universes: universes.map((u) => u.slug) };
}

const CV_ROLES: Record<string, string> = {
  writer: "Writer", plotter: "Writer", penciler: "Penciller", penciller: "Penciller", artist: "Artist", inker: "Inker",
  colorist: "Colorist", letterer: "Letterer", editor: "Editor", cover: "Cover Artist", "cover artist": "Cover Artist",
};

async function identityFor(ref: any, publisherId: Id | null) {
  const d = db();
  const hit = await d.identities.where("cv_id").equals(ref.id).first();
  if (hit) return hit;
  const { identity } = await ensureIdentity({ name: ref.name }, publisherId);
  if (!identity.cv_id) await d.identities.update(identity.id!, { cv_id: ref.id });
  return { ...identity, cv_id: identity.cv_id ?? ref.id };
}

/**
 * Everything Comic Vine knows about one issue: synopsis, credits, characters, teams and story
 * arcs, plus first appearances and deaths. One request.
 */
export async function syncCvIssue(cv: ComicVineApi, issueId: Id) {
  const d = db();
  const issue = await d.issues.get(issueId);
  if (!issue?.cv_id) return { skipped: "no Comic Vine id" };
  const i = await cv.getIssue(issue.cv_id);
  const series = await d.series.get(issue.series_id);
  const pubId = series?.publisher_id ?? null;
  const patch: Partial<Issue> = { deep_synced_at: nowIso() };
  if (!issue.title && i.name) patch.title = i.name;
  if (!issue.description) patch.description = cvText(i.description) ?? stripHtml(i.summary) ?? null;
  const cover = coverOf(i.image);
  if (cover && (!issue.image_url || isUnservableCover(issue.image_url))) patch.image_url = cover;
  if (!issue.cover_date && i.cover_date) patch.cover_date = i.cover_date;
  if (!issue.store_date && i.store_date) patch.store_date = i.store_date;
  await d.issues.update(issueId, patch);

  let credits = 0;
  for (const c of i.creators ?? []) {
    const creator = await ensureCreator(c.name);
    for (const r of String(c.roles ?? "").split(/,\s*/)) {
      const role = CV_ROLES[r.trim().toLowerCase()];
      if (role) { await addCredit(issueId, creator.id!, role); credits++; }
    }
  }
  for (const ref of i.characters ?? []) await addAppearance(issueId, await identityFor(ref, pubId), null);
  for (const ref of i.teams ?? []) {
    let team = await d.teams.where("cv_id").equals(ref.id).first();
    if (!team) {
      team = (await ensureTeam({ name: ref.name }, pubId)).team;
      if (!team.cv_id) await d.teams.update(team.id!, { cv_id: ref.id });
    }
    await addTeamAppearance(issueId, team.id!);
  }
  for (const ref of i.story_arcs ?? []) {
    let arc = await d.arcs.where("cv_id").equals(ref.id).first();
    if (!arc) arc = (await d.arcs.where("name").equals(ref.name).toArray()).find((a) => !a.publisher_id || !pubId || a.publisher_id === pubId);
    if (!arc) arc = await ensureArc(null, ref.name, pubId);
    if (!arc.cv_id) await d.arcs.update(arc.id!, { cv_id: ref.id });
    if (!(await d.arcIssues.get([arc.id!, issueId]))) {
      const position = (await d.arcIssues.where("arc_id").equals(arc.id!).count()) + 1;
      await d.arcIssues.put({ arc_id: arc.id!, issue_id: issueId, position, role: "core" });
    }
  }
  if (series) await refreshSeriesSpan(series.id!);
  const events = await enrichIssue(cv, issueId);
  return { issue_id: issueId, credits, characters: (i.characters ?? []).length, teams: (i.teams ?? []).length,
           arcs: (i.story_arcs ?? []).length, ...events };
}
