/** Characters (mantles) and identities, the appearance index, and team pages (port of characters.py). */
import { db, type Character, type Id, type Identity, type Issue, type Team } from "../db";
import { issueCards } from "./catalog";
import { linkedTeams, rosterTimeline, sharedTeamHistory } from "./teams";

interface IssueRef { id: Id; label: string; cover_date: string | null; image_url: string | null }

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const list = out.get(key(row));
    if (list) list.push(row);
    else out.set(key(row), [row]);
  }
  return out;
}

/** Every reference a page needs in two reads, rather than an issue get plus a series get each. */
async function issueRefs(ids: (Id | null | undefined)[]): Promise<Map<Id, IssueRef>> {
  const d = db();
  const unique = [...new Set(ids.filter((i): i is Id => !!i))];
  if (!unique.length) return new Map();
  const issues = (await d.issues.bulkGet(unique)).filter(Boolean) as Issue[];
  const series = (await d.series.bulkGet([...new Set(issues.map((i) => i.series_id))])).filter(Boolean);
  const names = new Map(series.map((x) => [x!.id!, x!.name]));
  return new Map(issues.map((i) => [i.id!, { id: i.id!, label: `${names.get(i.series_id) ?? ""} #${i.number}`,
    cover_date: i.cover_date ?? null, image_url: i.image_url ?? null }]));
}

async function issueRef(id: Id | null | undefined): Promise<IssueRef | null> {
  if (!id) return null;
  return (await issueRefs([id])).get(id) ?? null;
}

/** identity_id → appearances, from one walk of the index instead of a count() per character. */
async function appearanceCounts(): Promise<Map<Id, number>> {
  const counts = new Map<Id, number>();
  for (const key of await db().appearances.orderBy("identity_id").keys()) {
    const identityId = key as Id;
    counts.set(identityId, (counts.get(identityId) ?? 0) + 1);
  }
  return counts;
}

export async function listCharacters(q?: string | null, publisherId?: number | null, page = 1, size = 60) {
  const d = db();
  let chars: Character[];
  if (q) {
    const l = q.trim().toLowerCase();
    const viaIdentity = new Set((await d.identities.filter((i) => i.display_name.toLowerCase().includes(l) || (i.real_name ?? "").toLowerCase().includes(l)).toArray())
      .map((i) => i.character_id));
    chars = await d.characters.filter((c) => c.name.toLowerCase().includes(l) || viaIdentity.has(c.id!)).toArray();
  } else chars = await d.characters.toArray();
  if (publisherId) chars = chars.filter((c) => c.publisher_id === publisherId);
  // Counting and naming every character used to cost two queries each; both tables are read once.
  const [identities, counts] = await Promise.all([d.identities.toArray(), appearanceCounts()]);
  const byCharacter = groupBy(identities, (i) => i.character_id);
  const withCounts = chars.map((c) => ({
    c, apps: (byCharacter.get(c.id!) ?? []).reduce((n, i) => n + (counts.get(i.id!) ?? 0), 0),
  }));
  withCounts.sort((a, b) => b.apps - a.apps || a.c.name.localeCompare(b.c.name));
  const items = withCounts.slice((page - 1) * size, page * size).map(({ c, apps }) => ({
    id: c.id!, name: c.name, image_url: c.image_url ?? null, appearances: apps,
    identities: (byCharacter.get(c.id!) ?? []).map((i) => i.display_name),
  }));
  return { items, total: withCounts.length, page, size };
}

export async function characterDetail(id: Id) {
  const d = db();
  const c = await d.characters.get(id);
  if (!c) return null;
  const idents = (await d.identities.where("character_id").equals(id).toArray()).sort((a, b) => a.id! - b.id!);
  const identIds = idents.map((i) => i.id!);

  /*
   * This page used to re-query identities three times and then walk appearances, events and
   * memberships a row at a time, two more gets deep for every issue reference. Each table is
   * read once here and grouped in memory, which is what makes a character with a long history
   * open at the same speed as one with a short one.
   */
  const [apps, events, affiliations, memberships, orderRows] = await Promise.all([
    identIds.length ? d.appearances.where("identity_id").anyOf(identIds).toArray() : [],
    identIds.length ? d.characterEvents.where("identity_id").anyOf(identIds).toArray() : [],
    identIds.length ? d.teamAffiliations.where("identity_id").anyOf(identIds).toArray() : [],
    identIds.length ? d.memberships.where("identity_id").anyOf(identIds).toArray() : [],
    d.readingOrders.where("character_id").equals(id).toArray(),
  ]);

  const issues = (await d.issues.bulkGet([...new Set(apps.map((a) => a.issue_id))])).filter(Boolean) as Issue[];
  const issueById = new Map(issues.map((i) => [i.id!, i]));
  const seriesIds = [...new Set(issues.map((i) => i.series_id))];
  const uniBySeries = groupBy(seriesIds.length ? await d.seriesUniverses.where("series_id").anyOf(seriesIds).toArray() : [],
    (su) => su.series_id);
  const teamById = new Map(((await d.teams.bulkGet([...new Set(affiliations.map((a) => a.team_id))])).filter(Boolean) as Team[])
    .map((t) => [t.id!, t]));

  const refs = await issueRefs([
    ...events.flatMap((e) => [e.issue_id, e.end_issue_id]),
    ...idents.map((i) => i.first_appearance_issue_id),
    ...memberships.flatMap((m) => [m.from_issue_id, m.to_issue_id]),
  ]);
  const ref = (x: Id | null | undefined): IssueRef | null => (x ? refs.get(x) ?? null : null);

  const appsByIdent = groupBy(apps, (a) => a.identity_id);
  const eventsByIdent = groupBy(events, (e) => e.identity_id);
  const identities = idents.map((ident) => {
    const mine = appsByIdent.get(ident.id!) ?? [];
    const dates = mine.map((a) => issueById.get(a.issue_id)?.cover_date).filter(Boolean).sort() as string[];
    return {
      id: ident.id!, name: ident.name, display_name: ident.display_name, real_name: ident.real_name ?? null, aliases: ident.aliases ?? [],
      description: ident.description ?? null, image_url: ident.image_url ?? null, appearances: mine.length,
      first_seen: dates[0] ?? null, last_seen: dates[dates.length - 1] ?? null,
      first_appearance: ref(ident.first_appearance_issue_id) ?? (ident.first_appearance_text ? { id: null, label: ident.first_appearance_text } : null),
      events: (eventsByIdent.get(ident.id!) ?? []).sort((a, b) => a.kind.localeCompare(b.kind)).map((e) => ({
        id: e.id!, kind: e.kind, note: e.note ?? null, source: e.source,
        issue: ref(e.issue_id) ?? (e.issue_text ? { id: null, label: e.issue_text } : null),
        end_issue: ref(e.end_issue_id), image_url: e.image_url ?? null,
      })),
      metron_id: ident.metron_id ?? null, cv_id: ident.cv_id ?? null,
    };
  });

  const identById = new Map(idents.map((i) => [i.id!, i]));
  const teams = [];
  for (const a of affiliations) {
    const t = teamById.get(a.team_id);
    const ident = identById.get(a.identity_id);
    if (!t || !ident) continue;
    const ms = memberships.filter((m) => m.team_id === t.id && m.identity_id === ident.id);
    const froms = ms.map((m) => ref(m.from_issue_id)?.cover_date).filter(Boolean).sort() as string[];
    const tos = ms.map((m) => ref(m.to_issue_id)?.cover_date).filter(Boolean).sort() as string[];
    teams.push({ id: t.id!, name: t.name, image_url: t.image_url ?? null, identity: ident.display_name,
      since: froms[0] ?? null, until: tos[tos.length - 1] ?? null });
  }
  teams.sort((a, b) => (a.since === null) !== (b.since === null) ? (a.since === null ? 1 : -1) : (a.since ?? "").localeCompare(b.since ?? "") || a.name.localeCompare(b.name));

  const uniCounts = new Map<Id, Set<Id>>();
  for (const ap of apps) {
    const iss = issueById.get(ap.issue_id);
    if (!iss) continue;
    for (const su of uniBySeries.get(iss.series_id) ?? []) {
      if (!uniCounts.has(su.universe_id)) uniCounts.set(su.universe_id, new Set());
      uniCounts.get(su.universe_id)!.add(iss.id!);
    }
  }
  const universes = (await d.universes.bulkGet([...uniCounts.keys()])).filter(Boolean)
    .map((u) => ({ id: u!.id!, name: u!.name, issues: uniCounts.get(u!.id!)!.size })).sort((a, b) => b.issues - a.issues);
  const orders = orderRows.map((o) => ({ id: o.id!, name: o.name }));
  return { id: c.id!, name: c.name, description: c.description ?? null, image_url: c.image_url ?? null, publisher_id: c.publisher_id ?? null,
    identities, appearances: identities.reduce((n, i) => n + i.appearances, 0), teams, universes, reading_orders: orders };
}

export async function appearances(characterId: Id, f: { identity_id?: number | null; role?: string | null; universe_id?: number | null;
  era_id?: number | null; page?: number; size?: number }) {
  const d = db();
  const page = f.page ?? 1, size = f.size ?? 60;
  let idents = await d.identities.where("character_id").equals(characterId).toArray();
  if (f.identity_id) idents = idents.filter((i) => i.id === f.identity_id);
  const byId = new Map(idents.map((i) => [i.id!, i]));
  let apps = idents.length ? await d.appearances.where("identity_id").anyOf([...byId.keys()]).toArray() : [];
  if (f.role) apps = apps.filter((a) => a.role === f.role);
  const issues = new Map(((await d.issues.bulkGet(apps.map((a) => a.issue_id))).filter(Boolean) as Issue[]).map((i) => [i.id!, i]));
  const era = f.era_id ? await d.eras.get(f.era_id) : undefined;
  let universeId = f.universe_id ?? null;
  if (era) universeId = universeId ?? era.universe_id;
  let rows = apps.filter((a) => issues.has(a.issue_id)).map((a) => ({ a, issue: issues.get(a.issue_id)! }));
  if (era) rows = rows.filter(({ issue }) => issue.cover_date && issue.cover_date >= era.start_date && (!era.end_date || issue.cover_date <= era.end_date));
  if (universeId) {
    const inSeries = new Set((await d.seriesUniverses.where("universe_id").equals(universeId).toArray()).map((s) => s.series_id));
    const inIssue = new Set((await d.issueUniverses.where("universe_id").equals(universeId).toArray()).map((s) => s.issue_id));
    rows = rows.filter(({ issue }) => inSeries.has(issue.series_id) || inIssue.has(issue.id!));
  }
  rows.sort((x, y) => (x.issue.cover_date ?? "9999").localeCompare(y.issue.cover_date ?? "9999") || x.issue.number_sort - y.issue.number_sort);
  const slice = rows.slice((page - 1) * size, page * size);
  const cards = new Map((await issueCards(slice.map((r) => r.issue))).map((c) => [c.id, c]));
  return { items: slice.map(({ a, issue }) => ({ ...cards.get(issue.id!)!, role: a.role ?? null, identity: byId.get(a.identity_id)!.display_name,
    identity_id: a.identity_id })), total: rows.length, page, size };
}

export async function listTeams(q?: string | null, page = 1, size = 60) {
  const d = db();
  let teams = await d.teams.toArray();
  if (q) { const l = q.trim().toLowerCase(); teams = teams.filter((t) => t.name.toLowerCase().includes(l)); }
  const rows = await Promise.all(teams.map(async (t) => ({ id: t.id!, name: t.name, image_url: t.image_url ?? null,
    appearances: await d.teamAppearances.where("team_id").equals(t.id!).count(),
    members: await d.teamAffiliations.where("team_id").equals(t.id!).count() })));
  rows.sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));
  return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page, size };
}

export async function teamDetail(id: Id) {
  const d = db();
  const t = await d.teams.get(id);
  if (!t) return null;
  const apps = await d.teamAppearances.where("team_id").equals(id).toArray();
  const dates = ((await d.issues.bulkGet(apps.map((a) => a.issue_id))).filter(Boolean) as Issue[]).map((i) => i.cover_date).filter(Boolean).sort() as string[];
  const members = [];
  for (const a of await d.teamAffiliations.where("team_id").equals(id).toArray()) {
    const i = await d.identities.get(a.identity_id);
    if (!i) continue;
    const ch = await d.characters.get(i.character_id);
    members.push({ identity_id: i.id!, character_id: i.character_id, name: ch?.name ?? i.name, identity: i.display_name, image_url: i.image_url ?? null });
  }
  return {
    id: t.id!, name: t.name, description: t.description ?? null, image_url: t.image_url ?? null, appearances: apps.length,
    first_seen: dates[0] ?? null, last_seen: dates[dates.length - 1] ?? null,
    first_appearance: (await issueRef(t.first_appearance_issue_id)) ?? (t.first_appearance_text ? { id: null, label: t.first_appearance_text } : null),
    disbanded: t.disbanded_text ?? null, roster: await rosterTimeline(id), members, linked_teams: await linkedTeams(id),
    reading_orders: (await d.readingOrders.where("team_id").equals(id).toArray()).map((o) => ({ id: o.id!, name: o.name })),
    metron_id: t.metron_id ?? null, cv_id: t.cv_id ?? null,
  };
}

export async function teamIssues(id: Id, page = 1, size = 60) {
  const d = db();
  const issues = ((await d.issues.bulkGet((await d.teamAppearances.where("team_id").equals(id).toArray()).map((a) => a.issue_id))).filter(Boolean) as Issue[])
    .sort((a, b) => (a.cover_date ?? "9999").localeCompare(b.cover_date ?? "9999") || a.number_sort - b.number_sort);
  return { items: await issueCards(issues.slice((page - 1) * size, page * size)), total: issues.length, page, size };
}

export { sharedTeamHistory };
