/**
 * Grand Comics Database → catalog. GCD is keyless and covers every publisher, so it is the
 * baseline source: series, issues, covers, credits, synopses, genres, and the characters and
 * teams listed on each story (parsed from GCD's text conventions).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotFoundError } from "../contracts";
import { db, nowIso, type Id } from "../db";
import { defaultProcess, foldAccents } from "../parsing";
import { parseGcdCharacters, parseGcdCredits } from "../sources/gcd";
import { assignSeriesUniverses } from "../taxonomy";
import {
  addAffiliation, addAppearance, addCredit, addTeamAppearance, ensureCreator, ensureIdentity, ensureTeam,
  refreshSeriesSpan, upsertIssue, upsertPublisher, upsertSeries,
} from "./upserts";

/** The GCD client surface the sync uses (implemented in sources/gcd.ts). */
export interface GcdApi {
  searchSeries(name: string, year?: number | null): Promise<any[]>;
  series(id: number): Promise<any>;
  issue(id: number): Promise<any>;
  publisher(id: number): Promise<any>;
}

type Progress = (message: string) => void;

const STORY_ROLES: [string, string][] = [
  ["script", "Writer"], ["pencils", "Penciller"], ["inks", "Inker"], ["colors", "Colorist"], ["letters", "Letterer"], ["editing", "Editor"],
];

/** GCD key_date "1987-01-00" → "1987-01-01"; empty → null. */
export function gcdDate(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!m) return null;
  const month = m[2] === "00" ? "01" : m[2];
  const day = m[3] === "00" ? "01" : m[3];
  return `${m[1]}-${month}-${day}`;
}

/** "1 [2nd Printing]" → "1"; "Annual 1 [Variant]" → "Annual 1". */
export function issueNumberOf(descriptor: string): string {
  return descriptor.replace(/\s*\[.*$/, "").trim() || descriptor.trim() || "?";
}

async function ensurePublisher(api: GcdApi, gcdPublisherId: number | null | undefined) {
  if (gcdPublisherId == null) return undefined;
  const known = await db().publishers.where("gcd_id").equals(gcdPublisherId).first();
  if (known) return known;
  const p = await api.publisher(gcdPublisherId);
  return upsertPublisher({ gcd_id: gcdPublisherId }, p?.name ?? null, {
    country: p?.country ?? null, founded: p?.year_began ?? null,
  });
}

/** Series record plus an issue stub per (non-variant) issue; returns their GCD ids for detail jobs. */
export async function syncGcdSeries(api: GcdApi, gcdId: number, progress?: Progress) {
  const s = await api.series(gcdId);
  if (!s) throw new NotFoundError(`GCD series ${gcdId} not found`);
  const publisher = await ensurePublisher(api, s.publisher_id);
  const series = await upsertSeries({ gcd_id: gcdId }, {
    name: s.name, year_began: s.year_began ?? null, year_end: s.year_ended ?? null,
    series_type: s.publishing_format || null, description: s.notes || null, publisher_id: publisher?.id ?? null, synced_at: nowIso(),
  });
  const ids: number[] = s.active_issue_ids ?? s.active_issues ?? [];
  const descriptors: string[] = s.issue_descriptors ?? [];
  const issueIds: number[] = [];
  const seen = new Set<string>();
  for (const [i, gcdIssueId] of ids.entries()) {
    // GCD lists printings and variant covers as their own issues ("1 [1st Printing]", "1 [2nd Printing]",
    // "1 [Retailer Incentive Cover]"), base issue first; the catalog keeps the first one per number.
    const number = issueNumberOf(descriptors[i] ?? "");
    if (seen.has(number)) continue;
    seen.add(number);
    await upsertIssue({ gcd_id: gcdIssueId }, series.id!, { number });
    issueIds.push(gcdIssueId);
  }
  await db().series.update(series.id!, { issue_count: issueIds.length });
  await refreshSeriesSpan(series.id!);
  const universes = await assignSeriesUniverses(series.id!);
  progress?.(`${s.name}: ${issueIds.length} issues`);
  return { series_id: series.id!, issues: issueIds.length, issue_gcd_ids: issueIds, universes: universes.map((u) => u.slug) };
}

/** Full issue: cover, dates, credits, synopsis, genres, characters and teams. */
export async function syncGcdIssue(api: GcdApi, gcdId: number, progress?: Progress) {
  const d = db();
  const g = await api.issue(gcdId);
  if (!g) throw new NotFoundError(`GCD issue ${gcdId} not found`);
  if (g.variant_of) {
    // A variant cover: drop the stub, the base issue carries the data
    const stub = await d.issues.where("gcd_id").equals(gcdId).first();
    if (stub && !stub.metron_id) await d.issues.delete(stub.id!);
    return { skipped: "variant" };
  }
  let series = await d.series.where("gcd_id").equals(g.series_id).first();
  if (!series) series = (await d.series.get((await syncGcdSeries(api, g.series_id)).series_id))!;
  const stories: any[] = g.story_set ?? [];
  const synopsis = stories.map((st) => st.synopsis).filter(Boolean).join("\n\n") || null;
  const titles = stories.filter((st) => st.type !== "cover" && st.title).map((st) => st.title);
  const genres = [...new Set(stories.flatMap((st) => (st.genre ?? "").split(/;\s*/)).map((x: string) => x.trim()).filter(Boolean))];
  const pages = parseFloat(g.page_count);
  const issue = await upsertIssue({ gcd_id: gcdId }, series.id!, {
    // No image_url: GCD's cover scans can't be shown outside comics.org; covers come from Comic Vine or Metron
    number: g.number || issueNumberOf(g.descriptor ?? ""), title: g.title || (titles.length ? titles.slice(0, 3).join(", ") : null),
    cover_date: gcdDate(g.key_date), store_date: gcdDate(g.on_sale_date),
    description: synopsis, page_count: Number.isFinite(pages) && pages > 0 ? Math.round(pages) : null,
    isbn: g.isbn || null, upc: g.barcode || null, genres: genres.length ? genres : null,
    synced_at: nowIso(), deep_synced_at: nowIso(),
  });

  const pubId = series.publisher_id ?? null;
  for (const st of stories) {
    for (const [field, role] of STORY_ROLES) {
      for (const name of parseGcdCredits(st[field])) {
        const creator = await ensureCreator(name);
        await addCredit(issue.id!, creator.id!, st.type === "cover" ? `Cover ${role}` : role);
      }
    }
    if (st.type === "cover") continue;
    for (const ref of parseGcdCharacters(st.characters ?? "")) {
      if (ref.isTeam) {
        const { team } = await ensureTeam({ gcd_key: gcdKey(ref.name, pubId), name: ref.name }, pubId);
        await addTeamAppearance(issue.id!, team.id!);
        for (const m of ref.members ?? []) {
          const { identity } = await ensureIdentity({ gcd_key: gcdKey(m.person ? `${m.name} (${m.person})` : m.name, pubId),
            name: m.person ? `${m.name} (${m.person})` : m.name, person: m.person ?? null }, pubId);
          await addAppearance(issue.id!, identity, m.cameo ? "cameo" : null);
          await addAffiliation(identity.id!, team.id!, "gcd");
          await characterEvents(identity.id!, issue.id!, m, series.name, g.number);
        }
        continue;
      }
      const full = ref.person ? `${ref.name} (${ref.person})` : ref.name;
      const { identity } = await ensureIdentity({ gcd_key: gcdKey(full, pubId), name: full, person: ref.person ?? null }, pubId);
      await addAppearance(issue.id!, identity, ref.cameo ? "cameo" : null);
      await characterEvents(identity.id!, issue.id!, ref, series.name, g.number);
    }
  }
  await refreshSeriesSpan(series.id!);
  progress?.(`${series.name} #${issue.number}`);
  return { issue_id: issue.id! };
}

export function gcdKey(name: string, publisherId: Id | null): string {
  return `${publisherId ?? 0}:${name.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

async function characterEvents(identityId: Id, issueId: Id, ref: { firstAppearance?: boolean; death?: boolean }, seriesName: string, number: string) {
  const d = db();
  const label = `${seriesName} #${number}`;
  for (const [flag, kind] of [[ref.firstAppearance, "first_appearance"], [ref.death, "death"]] as const) {
    if (!flag) continue;
    const exists = (await d.characterEvents.where("identity_id").equals(identityId).toArray()).some((e) => e.kind === kind && e.issue_id === issueId);
    if (!exists) await d.characterEvents.add({ identity_id: identityId, kind, issue_id: issueId, issue_text: label, source: "gcd" });
    if (kind === "first_appearance") {
      const ident = await d.identities.get(identityId);
      if (ident && !ident.first_appearance_issue_id) await d.identities.update(identityId, { first_appearance_issue_id: issueId, first_appearance_text: label });
    }
  }
}

/** "The Amazing Spider-Man" → "amazing spider man", for ranking search hits. */
function bareTitle(name: string): string {
  return defaultProcess(foldAccents(name)).replace(/^(the|a|an|le|la|les|l|der|die|das|el|il) /, "");
}

/** GCD series search for "find online": exact titles first, then prefixes, then longer runs. */
export async function searchGcd(api: GcdApi, name: string, year?: number | null) {
  const results = await api.searchSeries(name, year);
  const want = bareTitle(name);
  const rank = (s: any) => { const t = bareTitle(s.name ?? ""); return t === want ? 0 : t.startsWith(want) ? 1 : 2; };
  const issues = (s: any) => (s.active_issue_ids ?? s.active_issues ?? []).length;
  results.sort((a: any, b: any) => rank(a) - rank(b) || issues(b) - issues(a));
  return results.map((s: any) => ({
    gcd_id: s.id, name: s.name, year_began: s.year_began ?? null, year_end: s.year_ended ?? null,
    issue_count: (s.active_issue_ids ?? s.active_issues ?? []).length, country: s.country ?? null, language: s.language ?? null,
    publisher_gcd_id: s.publisher_id ?? null,
  }));
}

/**
 * Finds a catalog series (added from Comic Vine or Metron) in GCD and links it and its issues,
 * so opening an issue also brings GCD's stories, synopses and character lists. One request.
 */
export async function linkGcdSeries(api: GcdApi, seriesId: Id) {
  const d = db();
  const s = await d.series.get(seriesId);
  if (!s) throw new NotFoundError(`Series ${seriesId} not found`);
  if (s.gcd_id) return { gcd_id: s.gcd_id, linked: 0 };
  const publisher = s.publisher_id ? (await d.publishers.get(s.publisher_id))?.name ?? "" : "";
  const want = bareTitle(s.name);
  const local = await d.issues.where("series_id").equals(seriesId).toArray();
  const candidates = (await api.searchSeries(s.name, s.year_began)).filter((g: any) => bareTitle(g.name ?? "") === want);
  const pubName = async (g: any) => (g.publisher_id != null ? (await d.publishers.where("gcd_id").equals(g.publisher_id).first())?.name ?? "" : "");
  let pick: any = null, bestScore = -Infinity;
  for (const c of candidates) {
    const count = (c.active_issue_ids ?? []).length;
    const p = await pubName(c);
    const samePub = publisher && p ? (p.toLowerCase().includes(publisher.toLowerCase()) || publisher.toLowerCase().includes(p.toLowerCase()) ? 20 : -20) : 0;
    const score = samePub - Math.abs(count - local.length) / Math.max(local.length, 1) * 10 + (c.language === "en" ? 2 : 0);
    if (score > bestScore) { bestScore = score; pick = c; }
  }
  if (!pick) return { found: false };
  if (await d.series.where("gcd_id").equals(pick.id).first()) return { found: false, reason: "already linked to another series" };
  await d.series.update(seriesId, { gcd_id: pick.id });
  const byNumber = new Map(local.map((i) => [i.number.trim(), i]));
  const seen = new Set<string>();
  let linked = 0;
  for (const [idx, gcdIssueId] of (pick.active_issue_ids ?? []).entries()) {
    const number = issueNumberOf(pick.issue_descriptors?.[idx] ?? "");
    if (seen.has(number)) continue;
    seen.add(number);
    const mine = byNumber.get(number);
    if (mine && !mine.gcd_id && !(await d.issues.where("gcd_id").equals(gcdIssueId).first())) {
      await d.issues.update(mine.id!, { gcd_id: gcdIssueId });
      linked++;
    }
  }
  return { gcd_id: pick.id as number, linked };
}
