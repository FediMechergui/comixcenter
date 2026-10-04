/**
 * Team rosters over time and the graphs between teams and characters (port of
 * backend/comix/services/teams.py). Sources say who is on a team, not when: stints run from the
 * first to the last issue where both the member and the team appear. Curated stints are kept.
 */
import { db, type Id, type Issue } from "../db";

async function coAppearances(teamId: Id, identityId: Id): Promise<Issue[]> {
  const d = db();
  const teamIssues = new Set(await d.teamAppearances.where("team_id").equals(teamId).toArray().then((r) => r.map((x) => x.issue_id)));
  const mine = (await d.appearances.where("identity_id").equals(identityId).toArray()).map((a) => a.issue_id).filter((i) => teamIssues.has(i));
  const issues = (await d.issues.bulkGet(mine)).filter((i): i is Issue => !!i && !!i.cover_date);
  return issues.sort((a, b) => (a.cover_date! < b.cover_date! ? -1 : a.cover_date! > b.cover_date! ? 1 : a.number_sort - b.number_sort));
}

export async function deriveMemberships(teamId: Id) {
  const d = db();
  if (!(await d.teams.get(teamId))) throw new Error(`team ${teamId} not found`);
  const memberIds = new Set((await d.teamAffiliations.where("team_id").equals(teamId).toArray()).map((a) => a.identity_id));
  const existing = await d.memberships.where("team_id").equals(teamId).toArray();
  const curated = new Set(existing.filter((m) => m.source === "curated").map((m) => m.identity_id));
  await d.memberships.bulkDelete(existing.filter((m) => m.source === "derived").map((m) => m.id!));
  let created = 0;
  for (const identityId of memberIds) {
    if (curated.has(identityId)) continue;
    const span = await coAppearances(teamId, identityId);
    await d.memberships.add({ team_id: teamId, identity_id: identityId, source: "derived",
      from_issue_id: span[0]?.id ?? null, to_issue_id: span[span.length - 1]?.id ?? null });
    created++;
  }
  return { team_id: teamId, members: memberIds.size, derived: created, curated_kept: curated.size };
}

async function issueRef(id: Id | null | undefined) {
  if (!id) return { id: null, date: null, label: null };
  const i = await db().issues.get(id);
  if (!i) return { id: null, date: null, label: null };
  const s = await db().series.get(i.series_id);
  return { id: i.id!, date: i.cover_date ?? null, label: `${s?.name ?? ""} #${i.number}` };
}

export async function rosterTimeline(teamId: Id) {
  const d = db();
  const rows = [];
  for (const m of await d.memberships.where("team_id").equals(teamId).toArray()) {
    const ident = await d.identities.get(m.identity_id);
    if (!ident) continue;
    const character = await d.characters.get(ident.character_id);
    const from = await issueRef(m.from_issue_id), to = await issueRef(m.to_issue_id);
    rows.push({
      id: m.id!, identity_id: ident.id!, display_name: ident.display_name, identity_name: ident.name,
      character_id: ident.character_id, character_name: character?.name ?? ident.display_name, image_url: ident.image_url ?? null,
      source: m.source, note: m.note ?? null,
      from_issue_id: from.id, from_date: from.date, from_label: from.label, to_issue_id: to.id, to_date: to.date, to_label: to.label,
    });
  }
  return rows.sort((a, b) => (a.from_date === null) !== (b.from_date === null) ? (a.from_date === null ? 1 : -1)
    : (a.from_date ?? "").localeCompare(b.from_date ?? "") || a.display_name.localeCompare(b.display_name));
}

export async function linkedTeams(teamId: Id, limit = 20) {
  const d = db();
  const links = new Map<Id, { team_id: Id; kinds: string[]; note: string | null; shared_members: number; name?: string; image_url?: string | null }>();
  for (const l of [...await d.teamLinks.where("team_id").equals(teamId).toArray(), ...await d.teamLinks.where("other_team_id").equals(teamId).toArray()]) {
    const other = l.team_id === teamId ? l.other_team_id : l.team_id;
    const entry = links.get(other) ?? { team_id: other, kinds: [], note: l.note ?? null, shared_members: 0 };
    if (!entry.kinds.includes(l.kind)) entry.kinds.push(l.kind);
    links.set(other, entry);
  }
  const members = (await d.teamAffiliations.where("team_id").equals(teamId).toArray()).map((a) => a.identity_id);
  const shared = new Map<Id, Set<Id>>();
  if (members.length) {
    for (const a of await d.teamAffiliations.where("identity_id").anyOf(members).toArray()) {
      if (a.team_id === teamId) continue;
      if (!shared.has(a.team_id)) shared.set(a.team_id, new Set());
      shared.get(a.team_id)!.add(a.identity_id);
    }
  }
  for (const [other, ids] of shared) {
    const entry = links.get(other) ?? { team_id: other, kinds: [], note: null, shared_members: 0 };
    entry.shared_members = ids.size;
    if (!entry.kinds.includes("shared_members")) entry.kinds.push("shared_members");
    links.set(other, entry);
  }
  const teams = await d.teams.bulkGet([...links.keys()]);
  const result = [...links.values()].map((e, i) => ({ ...e, name: teams[i]?.name ?? null, image_url: teams[i]?.image_url ?? null }));
  const curatedKinds = (e: { kinds: string[] }) => e.kinds.filter((k) => k !== "shared_members").length;
  return result.sort((a, b) => curatedKinds(b) - curatedKinds(a) || b.shared_members - a.shared_members).slice(0, limit);
}

/** Characters who served on a team with this character, most shared teams first. */
export async function sharedTeamHistory(characterId: Id, limit = 30) {
  const d = db();
  const myIdentities = (await d.identities.where("character_id").equals(characterId).toArray()).map((i) => i.id!);
  const myTeams = new Set((await d.teamAffiliations.where("identity_id").anyOf(myIdentities.length ? myIdentities : [-1]).toArray()).map((a) => a.team_id));
  const edges = new Map<Id, { character_id: Id; name: string; image_url: string | null; teams: Map<Id, string> }>();
  for (const teamId of myTeams) {
    const team = await d.teams.get(teamId);
    for (const a of await d.teamAffiliations.where("team_id").equals(teamId).toArray()) {
      if (myIdentities.includes(a.identity_id)) continue;
      const ident = await d.identities.get(a.identity_id);
      if (!ident || ident.character_id === characterId) continue;
      const ch = await d.characters.get(ident.character_id);
      if (!ch) continue;
      const e = edges.get(ch.id!) ?? { character_id: ch.id!, name: ch.name, image_url: ch.image_url ?? null, teams: new Map() };
      e.teams.set(teamId, team?.name ?? "");
      edges.set(ch.id!, e);
    }
  }
  const ranked = [...edges.values()].sort((a, b) => b.teams.size - a.teams.size).slice(0, limit);
  return { character_id: characterId, links: ranked.map((e) => ({ ...e, teams: [...e.teams].map(([team_id, name]) => ({ team_id, name })) })) };
}
