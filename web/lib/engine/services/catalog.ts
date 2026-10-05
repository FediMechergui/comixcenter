/**
 * Catalog browsing: publisher → universe → era → series → issue, and series / issue pages
 * (port of backend/comix/services/catalog.py, returning the same shapes).
 */
import { db, type Era, type Id, type Issue, type Series, type Universe } from "../db";

export const COLLECTED_TYPES = new Set(["trade paperback", "hard cover", "hardcover", "omnibus", "graphic novel"]);

export function seriesStart(s: Series): string | null {
  return s.first_cover_date ?? (s.year_began ? `${String(s.year_began).padStart(4, "0")}-01-01` : null);
}

export function seriesEnd(s: Series): string | null {
  const endYear = s.year_end ?? s.year_began;
  return s.last_cover_date ?? (endYear ? `${String(endYear).padStart(4, "0")}-12-31` : null) ?? seriesStart(s);
}

/** Series whose cover-date span overlaps the era. */
export function overlapsEra(s: Series, era: Era): boolean {
  const start = seriesStart(s), end = seriesEnd(s);
  if (!start || !end) return false;
  return start <= (era.end_date ?? "9999-12-31") && end >= era.start_date;
}

export async function publisherName(id: Id | null | undefined) {
  return id ? (await db().publishers.get(id))?.name ?? null : null;
}

export async function seriesCard(s: Series) {
  return {
    id: s.id!, name: s.name, volume: s.volume ?? null, year_began: s.year_began ?? null, year_end: s.year_end ?? null,
    issue_count: s.issue_count ?? null, image_url: s.image_url ?? null, series_type: s.series_type ?? null,
    publisher: await publisherName(s.publisher_id),
  };
}

export async function readIds(ids: Id[]): Promise<Set<Id>> {
  if (!ids.length) return new Set();
  return new Set((await db().readStatus.bulkGet(ids)).filter(Boolean).map((r) => r!.issue_id));
}

export async function ownedIds(ids: Id[]): Promise<Set<Id>> {
  if (!ids.length) return new Set();
  return new Set((await db().libraryFiles.where("issue_id").anyOf(ids).toArray()).map((f) => f.issue_id!));
}

export async function issueCards(issues: Issue[]) {
  const ids = issues.map((i) => i.id!);
  const [read, owned] = await Promise.all([readIds(ids), ownedIds(ids)]);
  const seriesIds = [...new Set(issues.map((i) => i.series_id))];
  const series = new Map((await db().series.bulkGet(seriesIds)).filter(Boolean).map((s) => [s!.id!, s!]));
  return issues.map((i) => {
    const s = series.get(i.series_id);
    return {
      id: i.id!, series_id: i.series_id, series_name: s?.name ?? "", series_year: s?.year_began ?? null, number: i.number,
      title: i.title ?? null, cover_date: i.cover_date ?? null, image_url: i.image_url ?? null,
      read: read.has(i.id!), owned: owned.has(i.id!),
    };
  });
}

// ── Browse ──

export async function listPublishers() {
  const d = db();
  const series = await d.series.toArray();
  const counts = new Map<Id, number>();
  for (const s of series) if (s.publisher_id) counts.set(s.publisher_id, (counts.get(s.publisher_id) ?? 0) + 1);
  const uniCounts = new Map<Id, number>();
  for (const u of await d.universes.toArray()) if (u.publisher_id) uniCounts.set(u.publisher_id, (uniCounts.get(u.publisher_id) ?? 0) + 1);
  const pubs = (await d.publishers.toArray()).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  return pubs.map((p) => ({ id: p.id!, name: p.name, slug: p.slug, image_url: p.image_url ?? null,
    series_count: counts.get(p.id!) ?? 0, universe_count: uniCounts.get(p.id!) ?? 0 }))
    .filter((p) => p.series_count || p.universe_count);
}

export async function universeCard(u: Universe) {
  const count = await db().seriesUniverses.where("universe_id").equals(u.id!).count();
  return { id: u.id!, name: u.name, slug: u.slug, kind: u.kind, designation: u.designation ?? null, description: u.description ?? null,
    series_count: count, publisher: await publisherName(u.publisher_id) };
}

export async function publisherDetail(id: Id) {
  const d = db();
  const p = await d.publishers.get(id);
  if (!p) return null;
  const sortUni = (a: Universe, b: Universe) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);
  const universes = (await d.universes.where("publisher_id").equals(id).toArray()).sort(sortUni);
  const cross = (await d.universes.filter((u) => u.publisher_id == null).toArray()).sort(sortUni);
  const classified = new Set((await d.seriesUniverses.toArray()).map((su) => su.series_id));
  const unclassified = (await d.series.where("publisher_id").equals(id).toArray()).filter((s) => !classified.has(s.id!)).length;
  return {
    id: p.id!, name: p.name, slug: p.slug, description: p.description ?? null, image_url: p.image_url ?? null,
    founded: p.founded ?? null, country: p.country ?? null,
    universes: await Promise.all(universes.map(universeCard)),
    cross_publisher_universes: await Promise.all(cross.map(universeCard)),
    unclassified_series_count: unclassified,
    imprints: (await d.imprints.where("publisher_id").equals(id).toArray()).map((i) => ({ id: i.id!, name: i.name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function universeDetail(id: Id) {
  const d = db();
  const u = await d.universes.get(id);
  if (!u) return null;
  const seriesIds = (await d.seriesUniverses.where("universe_id").equals(id).toArray()).map((su) => su.series_id);
  const series = (await d.series.bulkGet(seriesIds)).filter(Boolean) as Series[];
  const eras = (await d.eras.where("universe_id").equals(id).toArray()).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const orders = await d.readingOrders.where("universe_id").equals(id).toArray();
  return {
    ...(await universeCard(u)), publisher_id: u.publisher_id ?? null,
    eras: eras.map((e) => ({ id: e.id!, name: e.name, slug: e.slug, start_date: e.start_date, end_date: e.end_date ?? null,
      description: e.description ?? null, series_count: series.filter((s) => overlapsEra(s, e)).length })),
    reading_orders: orders.map((o) => ({ id: o.id!, name: o.name, era_id: o.era_id ?? null })),
  };
}

export interface SeriesFilter {
  publisher_id?: number | null; universe_id?: number | null; era_id?: number | null; q?: string | null;
  unclassified?: boolean; collected?: boolean | null; sort?: string; page?: number; size?: number;
}

export async function listSeries(f: SeriesFilter) {
  const d = db();
  const page = Math.max(1, f.page ?? 1), size = Math.max(1, Math.min(f.size ?? 50, 200));
  let rows: Series[];
  let universeId = f.universe_id ?? null;
  const era = f.era_id ? await d.eras.get(f.era_id) : undefined;
  if (f.era_id && !era) return { items: [], total: 0, page, size };
  if (era && !universeId) universeId = era.universe_id;
  if (universeId) {
    const ids = (await d.seriesUniverses.where("universe_id").equals(universeId).toArray()).map((su) => su.series_id);
    rows = (await d.series.bulkGet(ids)).filter(Boolean) as Series[];
  } else {
    rows = f.publisher_id ? await d.series.where("publisher_id").equals(f.publisher_id).toArray() : await d.series.toArray();
  }
  if (f.publisher_id && universeId) rows = rows.filter((s) => s.publisher_id === f.publisher_id);
  if (era) rows = rows.filter((s) => overlapsEra(s, era));
  if (f.unclassified) {
    const classified = new Set((await d.seriesUniverses.toArray()).map((su) => su.series_id));
    rows = rows.filter((s) => !classified.has(s.id!));
  }
  if (f.q) { const q = f.q.trim().toLowerCase(); rows = rows.filter((s) => s.name.toLowerCase().includes(q)); }
  if (f.collected != null) rows = rows.filter((s) => COLLECTED_TYPES.has((s.series_type ?? "").toLowerCase()) === f.collected);
  const key = (s: Series) => (s.sort_name ?? s.name).toLowerCase();
  if (f.sort === "year") rows.sort((a, b) => (a.year_began ?? 9999) - (b.year_began ?? 9999) || a.name.localeCompare(b.name));
  else if (f.sort === "recent") rows.sort((a, b) => (seriesEnd(b) ?? "").localeCompare(seriesEnd(a) ?? "") || a.name.localeCompare(b.name));
  else rows.sort((a, b) => key(a).localeCompare(key(b)) || (a.year_began ?? 0) - (b.year_began ?? 0));
  const slice = rows.slice((page - 1) * size, page * size);
  return { items: await Promise.all(slice.map(seriesCard)), total: rows.length, page, size };
}

async function overlappingEras(s: Series) {
  const d = db();
  const out = [];
  for (const su of await d.seriesUniverses.where("series_id").equals(s.id!).toArray()) {
    for (const era of await d.eras.where("universe_id").equals(su.universe_id).toArray()) {
      if (overlapsEra(s, era)) out.push({ id: era.id!, name: era.name, universe_id: era.universe_id });
    }
  }
  return out;
}

export async function seriesDetail(id: Id) {
  const d = db();
  const s = await d.series.get(id);
  if (!s) return null;
  const issues = (await d.issues.where("series_id").equals(id).toArray()).sort((a, b) => a.number_sort - b.number_sort || (a.cover_date ?? "").localeCompare(b.cover_date ?? ""));
  const issueIds = issues.map((i) => i.id!);
  const sus = await d.seriesUniverses.where("series_id").equals(id).toArray();
  const universes = (await d.universes.bulkGet(sus.map((su) => su.universe_id))).map((u, i) => u && { id: u.id!, name: u.name, kind: u.kind, source: sus[i].source }).filter(Boolean);
  const read = await readIds(issueIds);
  const arcCounts = new Map<Id, number>();
  for (const ai of issueIds.length ? await d.arcIssues.where("issue_id").anyOf(issueIds).toArray() : []) arcCounts.set(ai.arc_id, (arcCounts.get(ai.arc_id) ?? 0) + 1);
  const arcs = (await d.arcs.bulkGet([...arcCounts.keys()])).filter(Boolean).map((a) => ({ id: a!.id!, name: a!.name, kind: a!.kind, issue_count: arcCounts.get(a!.id!)! }));
  const writerCounts = new Map<Id, number>();
  for (const c of issueIds.length ? await d.credits.where("issue_id").anyOf(issueIds).toArray() : []) {
    if (/writer/i.test(c.role)) writerCounts.set(c.creator_id, (writerCounts.get(c.creator_id) ?? 0) + 1);
  }
  const writers = (await d.creators.bulkGet([...writerCounts.keys()])).filter(Boolean)
    .map((c) => ({ id: c!.id!, name: c!.name, issues: writerCounts.get(c!.id!)! })).sort((a, b) => b.issues - a.issues).slice(0, 8);
  const imprint = s.imprint_id ? await d.imprints.get(s.imprint_id) : undefined;
  return {
    ...(await seriesCard(s)), sort_name: s.sort_name ?? null, status: s.status ?? null, description: s.description ?? null,
    publisher_id: s.publisher_id ?? null, imprint: imprint?.name ?? null, first_cover_date: s.first_cover_date ?? null,
    last_cover_date: s.last_cover_date ?? null, metron_id: s.metron_id ?? null, cv_id: s.cv_id ?? null, gcd_id: s.gcd_id ?? null,
    synced_at: s.synced_at ?? null, universes, eras: await overlappingEras(s), issues: await issueCards(issues), read_count: read.size,
    arcs, writers,
    details_pending: await pendingDetails(issues),
  };
}

/** Issues of this list whose detail sync is queued or running right now. */
async function pendingDetails(issues: Issue[]): Promise<number> {
  const metronIds = new Set(issues.map((i) => i.metron_id).filter((x) => x != null));
  const gcdIds = new Set(issues.map((i) => i.gcd_id).filter((x) => x != null));
  const active = (await db().jobs.where("status").anyOf(["queued", "running"]).toArray());
  const seriesIds = new Set(issues.map((i) => i.series_id));
  return active.filter((j) => (j.kind === "metron.issue" && metronIds.has(Number(j.payload.metron_id)))
    || (j.kind === "comicvine.series_covers" && seriesIds.has(Number(j.payload.series_id)))
    || (j.kind === "gcd.issue" && gcdIds.has(Number(j.payload.gcd_id)))).length;
}

export async function issueDetail(id: Id) {
  const d = db();
  const i = await d.issues.get(id);
  if (!i) return null;
  const s = (await d.series.get(i.series_id))!;
  const credits = new Map<string, { id: Id; name: string }[]>();
  for (const c of await d.credits.where("issue_id").equals(id).toArray()) {
    const creator = await d.creators.get(c.creator_id);
    if (!creator) continue;
    if (!credits.has(c.role)) credits.set(c.role, []);
    if (!credits.get(c.role)!.some((x) => x.id === creator.id)) credits.get(c.role)!.push({ id: creator.id!, name: creator.name });
  }
  const arcLinks = await d.arcIssues.where("issue_id").equals(id).toArray();
  const arcs = await d.arcs.bulkGet(arcLinks.map((a) => a.arc_id));
  const apps = await d.appearances.where("issue_id").equals(id).toArray();
  const idents = await d.identities.bulkGet(apps.map((a) => a.identity_id));
  const characters = [];
  for (const [k, ident] of idents.entries()) {
    if (!ident) continue;
    const ch = await d.characters.get(ident.character_id);
    characters.push({ identity_id: ident.id!, character_id: ident.character_id, name: ch?.name ?? ident.name, identity: ident.display_name,
      image_url: ident.image_url ?? null, role: apps[k].role ?? null });
  }
  const teams = (await d.teams.bulkGet((await d.teamAppearances.where("issue_id").equals(id).toArray()).map((t) => t.team_id)))
    .filter(Boolean).map((t) => ({ id: t!.id!, name: t!.name, image_url: t!.image_url ?? null })).sort((a, b) => a.name.localeCompare(b.name));
  let uniIds = (await d.issueUniverses.where("issue_id").equals(id).toArray()).map((u) => u.universe_id);
  if (!uniIds.length) uniIds = (await d.seriesUniverses.where("series_id").equals(s.id!).toArray()).map((u) => u.universe_id);
  const universes = (await d.universes.bulkGet(uniIds)).filter(Boolean).map((u) => ({ id: u!.id!, name: u!.name, kind: u!.kind }));
  const collectedIn = (await d.issues.bulkGet((await d.collected.where("issue_id").equals(id).toArray()).map((c) => c.collection_issue_id))).filter(Boolean) as Issue[];
  const collects = ((await d.issues.bulkGet((await d.collected.where("collection_issue_id").equals(id).toArray()).map((c) => c.issue_id))).filter(Boolean) as Issue[])
    .sort((a, b) => (a.cover_date ?? "").localeCompare(b.cover_date ?? "") || a.number_sort - b.number_sort);
  const files = await d.libraryFiles.where("issue_id").equals(id).toArray();
  const events = [];
  for (const e of await d.characterEvents.where("issue_id").equals(id).toArray()) {
    const ident = await d.identities.get(e.identity_id);
    if (ident) events.push({ kind: e.kind, identity_id: ident.id!, character_id: ident.character_id, name: ident.display_name, note: e.note ?? null });
  }
  const orderRows = new Map<Id, { id: Id; name: string; tier: string }>();
  const arcIds = arcLinks.map((a) => a.arc_id);
  for (const e of [...await d.entries.where("issue_id").equals(id).toArray(), ...(arcIds.length ? await d.entries.where("arc_id").anyOf(arcIds).toArray() : [])]) {
    const o = await d.readingOrders.get(e.order_id);
    if (o && !orderRows.has(o.id!)) orderRows.set(o.id!, { id: o.id!, name: o.name, tier: e.tier });
  }
  const siblings = (await d.issues.where("series_id").equals(s.id!).toArray()).sort((a, b) => a.number_sort - b.number_sort);
  const idx = siblings.findIndex((x) => x.id === id);
  const prev = siblings.slice(0, idx).reverse().find((x) => x.number_sort < i.number_sort);
  const next = siblings.slice(idx + 1).find((x) => x.number_sort > i.number_sort);
  const isCollection = COLLECTED_TYPES.has((s.series_type ?? "").toLowerCase()) || collects.length > 0;
  const publisher = s.publisher_id ? await d.publishers.get(s.publisher_id) : undefined;
  const [card] = await issueCards([i]);
  return {
    ...card, description: i.description ?? null, store_date: i.store_date ?? null, page_count: i.page_count ?? null,
    isbn: i.isbn ?? null, upc: i.upc ?? null, metron_id: i.metron_id ?? null, cv_id: i.cv_id ?? null, gcd_id: i.gcd_id ?? null,
    deep_synced: !!i.deep_synced_at, genres: i.genres ?? [], series: await seriesCard(s), publisher_slug: publisher?.slug ?? null,
    credits: [...credits].map(([role, creators]) => ({ role, creators })).sort((a, b) => a.role.localeCompare(b.role)),
    arcs: arcs.map((a, k) => a && { id: a.id!, name: a.name, kind: a.kind, role: arcLinks[k].role, tier: arcLinks[k].tier ?? null }).filter(Boolean),
    characters, teams, universes,
    collected_in: await issueCards(collectedIn), collects: await issueCards(collects), is_collection: isCollection,
    files: files.map((f) => ({ id: f.id!, name: f.original_name, format: f.format, page_count: f.page_count, current_page: f.current_page })),
    events, reading_orders: [...orderRows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    previous_issue_id: prev?.id ?? null, next_issue_id: next?.id ?? null,
    legal_links: legalLinks(s.name, i.number, s.year_began ?? null, publisher?.slug ?? null, isCollection),
  };
}

/** "Where to read legally": search links into each service. */
export function legalLinks(seriesName: string, number: string | null, year: number | null, publisherSlug: string | null, isCollection: boolean) {
  const q = encodeURIComponent;
  const label = seriesName + (year ? ` (${year})` : "");
  const query = number && !isCollection ? `${seriesName} #${number}` : seriesName;
  const links: { service: string; kind: string; url: string }[] = [];
  if (publisherSlug === "marvel") links.push({ service: "Marvel Unlimited", kind: "subscription",
    url: `https://www.marvel.com/search?limit=20&query=${q(query)}&offset=0&content_type=comics` });
  if (publisherSlug === "dc") links.push({ service: "DC Universe Infinite", kind: "subscription",
    url: `https://www.google.com/search?q=${q(`site:dcuniverseinfinite.com ${query}`)}` });
  links.push({ service: "Kindle / comiXology", kind: "buy", url: `https://www.amazon.com/s?k=${q(label + (number ? ` ${number}` : ""))}&i=digital-text` });
  links.push({ service: "Your local library (Libby / hoopla)", kind: "library", url: `https://www.google.com/search?q=${q(`${query} comic libby OR hoopla`)}` });
  return links;
}
