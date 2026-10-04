/**
 * Metron → catalog (port of backend/comix/ingest/metron_sync.py). Objects from the Metron client
 * use mokkari's attribute names (number, cover_date, image, issue_name, series{id,name,...}, ...).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { db, nowIso, type Id, type Tier } from "../db";
import { parseComicTitle, slugify, words, numberSort } from "../parsing";
import { assignSeriesUniverses, universeForMetron } from "../taxonomy";
import {
  addAffiliation, addAppearance, addCredit, addTeamAppearance, ensureArc, ensureCreator, ensureIdentity, ensureTeam,
  refreshSeriesSpan, upsertIssue, upsertPublisher, upsertSeries,
} from "./upserts";

/** The Metron client surface the sync uses (implemented in sources/metron.ts). */
export interface MetronApi {
  publishersList(params?: Record<string, unknown>): Promise<any[]>;
  universe(id: number): Promise<any | null>;
  series(id: number): Promise<any | null>;
  seriesList(params?: Record<string, unknown>): Promise<any[]>;
  seriesIssuesList(id: number): Promise<any[]>;
  issue(id: number): Promise<any | null>;
  issuesList(params?: Record<string, unknown>): Promise<any[]>;
  arc(id: number): Promise<any | null>;
  arcsList(params?: Record<string, unknown>): Promise<any[]>;
  arcIssuesList(id: number): Promise<any[]>;
  character(id: number): Promise<any | null>;
  charactersList(params?: Record<string, unknown>): Promise<any[]>;
  characterIssuesList(id: number): Promise<any[]>;
  team(id: number): Promise<any | null>;
  teamsList(params?: Record<string, unknown>): Promise<any[]>;
  teamIssuesList(id: number): Promise<any[]>;
  readingList(id: number): Promise<any | null>;
  readingListsList(params?: Record<string, unknown>): Promise<any[]>;
  readingListItems(id: number): Promise<any[]>;
}

export type Progress = (message: string) => void;

const url = (v: unknown) => (v ? String(v) : null);

async function ensureSeriesStub(ref: any, publisherId?: Id | null) {
  const d = db();
  const hit = await d.series.where("metron_id").equals(ref.id).first();
  if (hit) {
    if (publisherId && !hit.publisher_id) await d.series.update(hit.id!, { publisher_id: publisherId });
    return hit;
  }
  return upsertSeries({ metron_id: ref.id }, { name: ref.name, volume: ref.volume ?? null, year_began: ref.year_began ?? null,
    publisher_id: publisherId ?? null });
}

/** Shallow upsert from a list item (BaseIssue / ReadingListIssue). */
export async function upsertIssueFromList(item: any, seriesId?: Id) {
  const series = seriesId ? await db().series.get(seriesId) : await ensureSeriesStub(item.series);
  const issueName: string | undefined = item.issue_name;
  // Metron list items name issues "Series (Year) #N"; keep only real titles
  const title = issueName && !(item.series?.name && issueName.toLowerCase().startsWith(item.series.name.toLowerCase())) ? issueName : undefined;
  return upsertIssue({ metron_id: item.id, cv_id: item.cv_id ?? null }, series!.id!, {
    number: item.number || "?", cover_date: item.cover_date ?? null, store_date: item.store_date ?? null,
    image_url: url(item.image), title, synced_at: nowIso(),
  });
}

export async function syncPublishers(api: MetronApi, progress?: Progress) {
  let count = 0;
  for (const item of await api.publishersList()) { await upsertPublisher({ metron_id: item.id }, item.name); count++; }
  progress?.(`${count} publishers`);
  return { publishers: count };
}

export async function ensureUniverse(api: MetronApi, ref: any) {
  const known = await db().universes.where("metron_id").equals(ref.id).first();
  if (known) return known;
  const detail = await api.universe(ref.id);
  const publisher = detail?.publisher ? await upsertPublisher({ metron_id: detail.publisher.id }, detail.publisher.name) : undefined;
  const uni = await universeForMetron(ref.id, detail?.name ?? ref.name, detail?.designation ?? null, publisher);
  if (detail?.desc && !uni.description) await db().universes.update(uni.id!, { description: detail.desc });
  return uni;
}

export async function syncSeries(api: MetronApi, metronId: number, progress?: Progress) {
  const detail = await api.series(metronId);
  if (!detail) throw new Error(`Metron series ${metronId} not found`);
  const publisher = detail.publisher ? await upsertPublisher({ metron_id: detail.publisher.id }, detail.publisher.name) : undefined;
  let imprintId: Id | null = null;
  if (detail.imprint) {
    const d = db();
    const imp = await d.imprints.where("metron_id").equals(detail.imprint.id).first();
    imprintId = imp?.id ?? await d.imprints.add({ metron_id: detail.imprint.id, name: detail.imprint.name, publisher_id: publisher?.id ?? null });
  }
  const series = await upsertSeries({ metron_id: metronId, cv_id: detail.cv_id ?? null, gcd_id: detail.gcd_id ?? null }, {
    name: detail.name, sort_name: detail.sort_name || null, volume: detail.volume ?? null, year_began: detail.year_began ?? null,
    year_end: detail.year_end ?? null, series_type: detail.series_type?.name ?? null, status: detail.status || null,
    description: detail.desc || null, issue_count: detail.issue_count ?? null, publisher_id: publisher?.id ?? null,
    imprint_id: imprintId, synced_at: nowIso(),
  });
  const issueIds: number[] = [];
  for (const item of await api.seriesIssuesList(metronId)) { await upsertIssueFromList(item, series.id); issueIds.push(item.id); }
  await refreshSeriesSpan(series.id!);
  const universes = await assignSeriesUniverses(series.id!);
  progress?.(`${series.name} (${series.year_began ?? "?"}): ${issueIds.length} issues`);
  return { series_id: series.id!, issues: issueIds.length, issue_metron_ids: issueIds, universes: universes.map((u) => u.slug) };
}

async function reprintStub(metronId: number, text: string, publisherId?: Id | null) {
  const d = db();
  const hit = await d.issues.where("metron_id").equals(metronId).first();
  if (hit) return hit;
  const parsed = parseComicTitle(text);
  const series = (await d.series.where("name").equals(parsed.series_name).toArray())
    .find((s) => s.metron_id == null && (s.year_began ?? null) === parsed.year)
    ?? await upsertSeries({}, { name: parsed.series_name, year_began: parsed.year, publisher_id: publisherId ?? null });
  return upsertIssue({ metron_id: metronId }, series.id!, { number: parsed.issue_number ?? "?" });
}

/** Full issue record: description, credits, arcs, characters, teams, universes, reprints. */
export async function syncIssue(api: MetronApi, metronId: number, progress?: Progress) {
  const d = db();
  const detail = await api.issue(metronId);
  if (!detail) throw new Error(`Metron issue ${metronId} not found`);
  const publisher = detail.publisher ? await upsertPublisher({ metron_id: detail.publisher.id }, detail.publisher.name) : undefined;
  const pubId = publisher?.id ?? null;
  const series = await ensureSeriesStub(detail.series, pubId);
  if (detail.imprint && !series.imprint_id) {
    const imp = await d.imprints.where("metron_id").equals(detail.imprint.id).first();
    await d.series.update(series.id!, { imprint_id: imp?.id ?? await d.imprints.add({ metron_id: detail.imprint.id, name: detail.imprint.name, publisher_id: pubId }) });
  }
  if (detail.series?.series_type && !series.series_type) await d.series.update(series.id!, { series_type: detail.series.series_type.name });
  const titles: string[] = (detail.story_titles ?? []).filter(Boolean);
  const issue = await upsertIssue({ metron_id: detail.id, cv_id: detail.cv_id ?? null, gcd_id: detail.gcd_id ?? null }, series.id!, {
    number: detail.number || "?", cover_date: detail.cover_date ?? null, store_date: detail.store_date ?? null,
    image_url: url(detail.image), title: detail.collection_title || (titles.length ? titles.join(", ") : null),
    description: detail.desc || null, page_count: detail.page_count ?? null, isbn: detail.isbn || null, upc: detail.upc || null,
    synced_at: nowIso(), deep_synced_at: nowIso(),
  });

  for (const credit of detail.credits ?? []) {
    const creator = await ensureCreator(credit.creator, credit.id);
    for (const role of credit.role ?? []) await addCredit(issue.id!, creator.id!, role.name);
  }
  for (const ref of detail.arcs ?? []) {
    const arc = await ensureArc(ref.id, ref.name, pubId);
    if (!arc.publisher_id && pubId) await d.arcs.update(arc.id!, { publisher_id: pubId });
    if (!(await d.arcIssues.get([arc.id!, issue.id!]))) await d.arcIssues.put({ arc_id: arc.id!, issue_id: issue.id!, position: 0, role: "core" });
  }
  const newIdentities: Id[] = [], newTeams: Id[] = [];
  for (const ref of detail.characters ?? []) {
    const { identity, created } = await ensureIdentity({ metron_id: ref.id, name: ref.name }, pubId);
    if (created) newIdentities.push(identity.id!);
    await addAppearance(issue.id!, identity);
  }
  for (const ref of detail.teams ?? []) {
    const { team, created } = await ensureTeam({ metron_id: ref.id, name: ref.name }, pubId);
    if (created) newTeams.push(team.id!);
    await addTeamAppearance(issue.id!, team.id!);
  }
  for (const ref of detail.universes ?? []) {
    const uni = await ensureUniverse(api, ref);
    if (!(await d.issueUniverses.get([issue.id!, uni.id!]))) await d.issueUniverses.put({ issue_id: issue.id!, universe_id: uni.id! });
  }
  for (const reprint of detail.reprints ?? []) {
    const original = await reprintStub(reprint.id, reprint.issue, pubId);
    if (original.id !== issue.id && !(await d.collected.get([issue.id!, original.id!]))) {
      await d.collected.put({ collection_issue_id: issue.id!, issue_id: original.id! });
    }
  }
  await refreshSeriesSpan(series.id!);
  if ((detail.universes ?? []).length) await assignSeriesUniverses(series.id!);
  progress?.(`${series.name} #${issue.number}`);
  return { issue_id: issue.id!, new_identity_ids: newIdentities, new_team_ids: newTeams };
}

export async function syncArc(api: MetronApi, metronId: number, progress?: Progress) {
  const d = db();
  const detail = await api.arc(metronId);
  if (!detail) throw new Error(`Metron arc ${metronId} not found`);
  const arc = await ensureArc(metronId, detail.name);
  await d.arcs.update(arc.id!, { name: detail.name, description: detail.desc || arc.description || null,
    image_url: url(detail.image) ?? arc.image_url ?? null, cv_id: detail.cv_id ?? arc.cv_id ?? null, words: words(detail.name) });
  const issueIds: number[] = [];
  for (const [position, item] of (await api.arcIssuesList(metronId)).entries()) {
    const issue = await upsertIssueFromList(item);
    const link = await d.arcIssues.get([arc.id!, issue.id!]);
    await d.arcIssues.put({ ...(link ?? { role: "core" as const }), arc_id: arc.id!, issue_id: issue.id!, position });
    issueIds.push(item.id);
    const series = await d.series.get(issue.series_id);
    const current = await d.arcs.get(arc.id!);
    if (!current?.publisher_id && series?.publisher_id) await d.arcs.update(arc.id!, { publisher_id: series.publisher_id });
  }
  await d.arcs.update(arc.id!, { synced_at: nowIso() });
  progress?.(`${detail.name}: ${issueIds.length} issues`);
  return { arc_id: arc.id!, issues: issueIds.length, issue_metron_ids: issueIds };
}

export async function syncCharacter(api: MetronApi, metronId: number, withIssues = true, progress?: Progress) {
  const d = db();
  const detail = await api.character(metronId);
  if (!detail) throw new Error(`Metron character ${metronId} not found`);
  const { identity } = await ensureIdentity({ metron_id: metronId, name: detail.name });
  const patch = {
    aliases: (detail.alias ?? []).length ? detail.alias : identity.aliases ?? null,
    description: detail.desc || identity.description || null,
    image_url: url(detail.image) ?? identity.image_url ?? null,
    cv_id: detail.cv_id ?? identity.cv_id ?? null,
  };
  await d.identities.update(identity.id!, { ...patch, words: words(identity.display_name, identity.name, identity.real_name, ...(patch.aliases ?? [])) });
  const character = await d.characters.get(identity.character_id);
  if (character && !character.image_url && patch.image_url) await d.characters.update(character.id!, { image_url: patch.image_url });
  if (character && !character.description && character.name === identity.name && patch.description) {
    await d.characters.update(character.id!, { description: patch.description });
  }
  for (const ref of detail.teams ?? []) {
    const { team } = await ensureTeam({ metron_id: ref.id, name: ref.name }, identity.publisher_id);
    await addAffiliation(identity.id!, team.id!, "metron");
  }
  let count = 0;
  if (withIssues) {
    for (const item of await api.characterIssuesList(metronId)) {
      const issue = await upsertIssueFromList(item);
      const fresh = (await d.identities.get(identity.id!))!;
      if (!fresh.publisher_id) {
        const series = await d.series.get(issue.series_id);
        if (series?.publisher_id) await d.identities.update(identity.id!, { publisher_id: series.publisher_id });
      }
      await addAppearance(issue.id!, fresh);
      count++;
    }
  }
  await d.identities.update(identity.id!, { synced_at: nowIso() });
  progress?.(`${detail.name}: ${count} appearances`);
  return { identity_id: identity.id!, character_id: identity.character_id, appearances: count };
}

export async function syncTeam(api: MetronApi, metronId: number, withIssues = true, progress?: Progress) {
  const d = db();
  const detail = await api.team(metronId);
  if (!detail) throw new Error(`Metron team ${metronId} not found`);
  const { team } = await ensureTeam({ metron_id: metronId, name: detail.name });
  await d.teams.update(team.id!, { name: detail.name, description: detail.desc || team.description || null,
    image_url: url(detail.image) ?? team.image_url ?? null, cv_id: detail.cv_id ?? team.cv_id ?? null, words: words(detail.name) });
  let count = 0;
  if (withIssues) {
    for (const item of await api.teamIssuesList(metronId)) {
      const issue = await upsertIssueFromList(item);
      const current = await d.teams.get(team.id!);
      if (!current?.publisher_id) {
        const series = await d.series.get(issue.series_id);
        if (series?.publisher_id) await d.teams.update(team.id!, { publisher_id: series.publisher_id });
      }
      await addTeamAppearance(issue.id!, team.id!);
      count++;
    }
  }
  await d.teams.update(team.id!, { synced_at: nowIso() });
  progress?.(`${detail.name}: ${count} appearances`);
  return { team_id: team.id!, appearances: count };
}

export function tierForReadingListType(issueType: string | null | undefined): Tier {
  const kind = (issueType ?? "").toLowerCase();
  if (kind.includes("core") || kind.includes("main")) return "essential";
  if (kind.includes("tie") || kind.includes("crossover")) return "tie_in";
  if (kind.includes("optional") || kind.includes("extra")) return "optional";
  return "recommended";
}

/** Imports a Metron community reading list as a reading order (source = metron). */
export async function syncReadingList(api: MetronApi, metronId: number, progress?: Progress) {
  const d = db();
  const detail = await api.readingList(metronId);
  if (!detail) throw new Error(`Metron reading list ${metronId} not found`);
  let order = await d.readingOrders.where("metron_reading_list_id").equals(metronId).first();
  const description = (`${detail.desc ?? ""}${detail.attribution_source ? `\n\nSource: ${detail.attribution_source}` : ""}`).trim() || null;
  if (!order) {
    let slug = slugify(detail.name);
    if (await d.readingOrders.where("slug").equals(slug).first()) slug = `${slug}-metron-${metronId}`;
    const id = await d.readingOrders.add({ name: detail.name, slug, kind: "custom", source: "metron", metron_reading_list_id: metronId,
      description, created_at: nowIso(), updated_at: nowIso(), words: words(detail.name, description) });
    order = (await d.readingOrders.get(id))!;
  } else {
    await d.readingOrders.update(order.id!, { name: detail.name, description, updated_at: nowIso(), words: words(detail.name, description) });
  }
  await d.entries.where("order_id").equals(order.id!).delete();
  const items = (await api.readingListItems(metronId)).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
  for (const [position, item] of items.entries()) {
    const issue = await upsertIssueFromList(item.issue);
    await d.entries.add({ order_id: order.id!, position, issue_id: issue.id!, tier: tierForReadingListType(item.issue_type) });
  }
  progress?.(`${detail.name}: ${items.length} entries`);
  return { order_id: order.id!, entries: items.length };
}

/** Metron search for the "find online" lists. */
export async function search(api: MetronApi, kind: string, query: string, year?: number | null) {
  const params: Record<string, unknown> = { name: query };
  if (kind === "series") {
    if (year) params.year_began = year;
    return (await api.seriesList(params)).map((s: any) => ({
      metron_id: s.id, name: s.display_name ?? s.name, year_began: s.year_began, issue_count: s.issue_count,
      publisher: s.publisher?.name ?? null, series_type: s.series_type?.name ?? null,
    }));
  }
  const listing: Record<string, (p: Record<string, unknown>) => Promise<any[]>> = {
    arc: (p) => api.arcsList(p), character: (p) => api.charactersList(p), team: (p) => api.teamsList(p),
    reading_list: (p) => api.readingListsList(p),
  };
  const fn = listing[kind];
  if (!fn) throw new Error(`Unknown search kind ${kind}`);
  return (await fn(params)).map((r: any) => ({ metron_id: r.id, name: r.name }));
}

export { numberSort };
