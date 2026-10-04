/** Characters (mantles) and identities, the appearance index, and team pages (port of characters.py). */
import { db, type Character, type Id, type Issue } from "../db";
import { issueCards } from "./catalog";
import { linkedTeams, rosterTimeline, sharedTeamHistory } from "./teams";

async function issueRef(id: Id | null | undefined) {
  if (!id) return null;
  const i = await db().issues.get(id);
  if (!i) return null;
  const s = await db().series.get(i.series_id);
  return { id: i.id!, label: `${s?.name ?? ""} #${i.number}`, cover_date: i.cover_date ?? null, image_url: i.image_url ?? null };
}

async function appearanceCount(characterId: Id) {
  const ids = (await db().identities.where("character_id").equals(characterId).toArray()).map((i) => i.id!);
  return ids.length ? db().appearances.where("identity_id").anyOf(ids).count() : 0;
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
  const withCounts = await Promise.all(chars.map(async (c) => ({ c, apps: await appearanceCount(c.id!) })));
  withCounts.sort((a, b) => b.apps - a.apps || a.c.name.localeCompare(b.c.name));
  const slice = withCounts.slice((page - 1) * size, page * size);
  const items = await Promise.all(slice.map(async ({ c, apps }) => ({ id: c.id!, name: c.name, image_url: c.image_url ?? null, appearances: apps,
    identities: (await d.identities.where("character_id").equals(c.id!).toArray()).map((i) => i.display_name) })));
  return { items, total: withCounts.length, page, size };
}

export async function characterDetail(id: Id) {
  const d = db();
  const c = await d.characters.get(id);
  if (!c) return null;
  const identities = [];
  for (const ident of (await d.identities.where("character_id").equals(id).toArray()).sort((a, b) => a.id! - b.id!)) {
    const apps = await d.appearances.where("identity_id").equals(ident.id!).toArray();
    const dates = ((await d.issues.bulkGet(apps.map((a) => a.issue_id))).filter(Boolean) as Issue[]).map((i) => i.cover_date).filter(Boolean).sort() as string[];
    const events = [];
    for (const e of (await d.characterEvents.where("identity_id").equals(ident.id!).toArray()).sort((a, b) => a.kind.localeCompare(b.kind))) {
      events.push({ id: e.id!, kind: e.kind, note: e.note ?? null, source: e.source,
        issue: (await issueRef(e.issue_id)) ?? (e.issue_text ? { id: null, label: e.issue_text } : null),
        end_issue: await issueRef(e.end_issue_id), image_url: e.image_url ?? null });
    }
    identities.push({
      id: ident.id!, name: ident.name, display_name: ident.display_name, real_name: ident.real_name ?? null, aliases: ident.aliases ?? [],
      description: ident.description ?? null, image_url: ident.image_url ?? null, appearances: apps.length,
      first_seen: dates[0] ?? null, last_seen: dates[dates.length - 1] ?? null,
      first_appearance: (await issueRef(ident.first_appearance_issue_id)) ?? (ident.first_appearance_text ? { id: null, label: ident.first_appearance_text } : null),
      events, metron_id: ident.metron_id ?? null, cv_id: ident.cv_id ?? null,
    });
  }
  const teams = [];
  for (const ident of await d.identities.where("character_id").equals(id).toArray()) {
    for (const a of await d.teamAffiliations.where("identity_id").equals(ident.id!).toArray()) {
      const t = await d.teams.get(a.team_id);
      if (!t) continue;
      const ms = (await d.memberships.where("team_id").equals(t.id!).toArray()).filter((m) => m.identity_id === ident.id);
      const froms = (await Promise.all(ms.map((m) => issueRef(m.from_issue_id)))).map((r) => r?.cover_date).filter(Boolean).sort() as string[];
      const tos = (await Promise.all(ms.map((m) => issueRef(m.to_issue_id)))).map((r) => r?.cover_date).filter(Boolean).sort() as string[];
      teams.push({ id: t.id!, name: t.name, image_url: t.image_url ?? null, identity: ident.display_name, since: froms[0] ?? null, until: tos[tos.length - 1] ?? null });
    }
  }
  teams.sort((a, b) => (a.since === null) !== (b.since === null) ? (a.since === null ? 1 : -1) : (a.since ?? "").localeCompare(b.since ?? "") || a.name.localeCompare(b.name));
  const uniCounts = new Map<Id, Set<Id>>();
  for (const ident of await d.identities.where("character_id").equals(id).toArray()) {
    for (const ap of await d.appearances.where("identity_id").equals(ident.id!).toArray()) {
      const iss = await d.issues.get(ap.issue_id);
      if (!iss) continue;
      for (const su of await d.seriesUniverses.where("series_id").equals(iss.series_id).toArray()) {
        if (!uniCounts.has(su.universe_id)) uniCounts.set(su.universe_id, new Set());
        uniCounts.get(su.universe_id)!.add(iss.id!);
      }
    }
  }
  const universes = (await d.universes.bulkGet([...uniCounts.keys()])).filter(Boolean)
    .map((u) => ({ id: u!.id!, name: u!.name, issues: uniCounts.get(u!.id!)!.size })).sort((a, b) => b.issues - a.issues);
  const orders = (await d.readingOrders.where("character_id").equals(id).toArray()).map((o) => ({ id: o.id!, name: o.name }));
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
