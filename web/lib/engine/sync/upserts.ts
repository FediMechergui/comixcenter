/**
 * Idempotent upserts shared by the Metron and GCD sync. Records are matched on the source's id
 * first, then on cross-source ids (Metron records carry gcd_id / cv_id), so the same series or
 * issue arriving from two sources lands on one row.
 */
import {
  db, nowIso, type AppearanceRole, type Arc, type Character, type Creator, type Id, type Identity, type Issue,
  type Publisher, type Series, type Team,
} from "../db";
import { numberSort, slugify, splitMantle, words } from "../parsing";
import { publisherForName } from "../taxonomy";

export interface SourceIds { metron_id?: number | null; gcd_id?: number | null; cv_id?: number | null }

async function findBy<T extends { id?: Id }>(table: import("dexie").Table<T, Id>, ids: SourceIds): Promise<T | undefined> {
  for (const key of ["metron_id", "gcd_id", "cv_id"] as const) {
    const v = ids[key];
    if (v != null) {
      const hit = await table.where(key).equals(v).first();
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Fill only the given non-empty fields (never wipe what another source provided). */
function fill<T extends object>(patch: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== "") (out as Record<string, unknown>)[k] = v;
  return out;
}

export async function upsertPublisher(ids: SourceIds, name: string | null | undefined, detail?: Partial<Publisher>): Promise<Publisher | undefined> {
  const d = db();
  if (!name && ids.metron_id == null && ids.gcd_id == null) return undefined;
  let pub = await findBy(d.publishers, ids);
  if (!pub) {
    pub = await publisherForName(name);
    if (!pub && name) {
      const slug = slugify(name);
      pub = await d.publishers.where("slug").equals(slug).first();
      if (!pub) {
        const id = await d.publishers.add({ name, slug, sort_order: 200 });
        pub = (await d.publishers.get(id))!;
      }
    }
  }
  if (!pub) return undefined;
  const patch: Partial<Publisher> = {};
  for (const key of ["metron_id", "gcd_id", "cv_id"] as const) if (ids[key] != null && pub[key] == null) patch[key] = ids[key];
  Object.assign(patch, fill(detail ?? {}));
  if (Object.keys(patch).length) await d.publishers.update(pub.id!, patch);
  return { ...pub, ...patch };
}

export async function upsertSeries(ids: SourceIds, fields: Partial<Series> & { name: string }): Promise<Series> {
  const d = db();
  const existing = await findBy(d.series, ids);
  const merged: Partial<Series> = { ...fill(fields), ...fill(ids) };
  if (existing) {
    const next = { ...existing, ...merged };
    next.words = words(next.name, next.year_began ? String(next.year_began) : null);
    await d.series.put(next);
    return next;
  }
  const row = { ...merged, name: fields.name, words: words(fields.name, fields.year_began ? String(fields.year_began) : null) } as Series;
  row.id = await d.series.add(row);
  return row;
}

export async function upsertIssue(ids: SourceIds, seriesId: Id, fields: Partial<Issue> & { number: string }): Promise<Issue> {
  const d = db();
  const existing = await findBy(d.issues, ids);
  const series = await d.series.get(seriesId);
  const merged: Partial<Issue> = { ...fill(fields), ...fill(ids) };
  const base = existing ?? ({ series_id: seriesId, number: fields.number } as Issue);
  const next = { ...base, ...merged, series_id: seriesId } as Issue;
  next.number_sort = numberSort(next.number);
  next.words = words(series?.name, next.number, next.title);
  if (existing) await d.issues.put(next);
  else next.id = await d.issues.add(next);
  return next;
}

/** Keeps the series' cover-date span, issue count and cover current (eras use the span). */
export async function refreshSeriesSpan(seriesId: Id): Promise<void> {
  const d = db();
  const issues = await d.issues.where("series_id").equals(seriesId).toArray();
  const dates = issues.map((i) => i.cover_date).filter(Boolean).sort() as string[];
  const series = await d.series.get(seriesId);
  if (!series) return;
  const patch: Partial<Series> = { first_cover_date: dates[0] ?? null, last_cover_date: dates[dates.length - 1] ?? null };
  if (!series.issue_count || issues.length > series.issue_count) patch.issue_count = issues.length;
  if (!series.image_url) {
    const first = issues.filter((i) => i.image_url).sort((a, b) => a.number_sort - b.number_sort)[0];
    if (first) patch.image_url = first.image_url;
  }
  await d.series.update(seriesId, patch);
}

export async function ensureCreator(name: string, metronId?: number | null): Promise<Creator> {
  const d = db();
  if (metronId != null) {
    const hit = await d.creators.where("metron_id").equals(metronId).first();
    if (hit) return hit;
  }
  const byName = (await d.creators.where("name").equals(name).toArray()).find((c) => metronId == null || c.metron_id == null);
  if (byName) {
    if (metronId != null && byName.metron_id == null) await d.creators.update(byName.id!, { metron_id: metronId });
    return byName;
  }
  const row: Creator = { name, metron_id: metronId ?? null, words: words(name) };
  row.id = await d.creators.add(row);
  return row;
}

export async function addCredit(issueId: Id, creatorId: Id, role: string): Promise<void> {
  const d = db();
  const exists = await d.credits.where("[issue_id+creator_id+role]").equals([issueId, creatorId, role]).first();
  if (!exists) await d.credits.add({ issue_id: issueId, creator_id: creatorId, role });
}

export async function ensureArc(metronId: number | null, name: string, publisherId?: Id | null): Promise<Arc> {
  const d = db();
  if (metronId != null) {
    const hit = await d.arcs.where("metron_id").equals(metronId).first();
    if (hit) return hit;
  }
  const row: Arc = { name, kind: "arc", metron_id: metronId, publisher_id: publisherId ?? null, words: words(name) };
  row.id = await d.arcs.add(row);
  return row;
}

async function findCharacter(mantle: string, publisherId?: Id | null): Promise<Character | undefined> {
  const lower = mantle.toLowerCase();
  const candidates = await db().characters.where("words").equals(words(mantle)[0] ?? lower).toArray();
  return candidates.filter((c) => c.name.toLowerCase() === lower && (!publisherId || !c.publisher_id || c.publisher_id === publisherId))
    .sort((a, b) => a.id! - b.id!)[0];
}

/**
 * Identity for a character reference, creating its mantle from the name ("Spider-Man (Miles
 * Morales)" → Spider-Man / Miles Morales). Source key: Metron id, or a GCD name key.
 */
export async function ensureIdentity(ref: { metron_id?: number | null; gcd_key?: string | null; name: string; person?: string | null },
                                     publisherId?: Id | null): Promise<{ identity: Identity; created: boolean }> {
  const d = db();
  if (ref.metron_id != null) {
    const hit = await d.identities.where("metron_id").equals(ref.metron_id).first();
    if (hit) return { identity: hit, created: false };
  }
  if (ref.gcd_key) {
    const hit = await d.identities.where("gcd_key").equals(ref.gcd_key).first();
    if (hit) return { identity: hit, created: false };
  }
  let [mantle, person] = splitMantle(ref.name);
  if (ref.person) person = ref.person;
  // Same person already known from another source (matched by mantle + person name)
  const character = await findCharacter(mantle, publisherId);
  if (character) {
    const same = (await d.identities.where("character_id").equals(character.id!).toArray())
      .find((i) => i.display_name.toLowerCase() === person.toLowerCase() || (i.real_name ?? "").toLowerCase() === person.toLowerCase());
    if (same) {
      const patch: Partial<Identity> = {};
      if (ref.metron_id != null && same.metron_id == null) patch.metron_id = ref.metron_id;
      if (ref.gcd_key && !same.gcd_key) patch.gcd_key = ref.gcd_key;
      if (Object.keys(patch).length) await d.identities.update(same.id!, patch);
      return { identity: { ...same, ...patch }, created: false };
    }
  }
  let characterId = character?.id;
  if (characterId == null) {
    characterId = await d.characters.add({ name: mantle, publisher_id: publisherId ?? null, words: words(mantle) });
  }
  const identity: Identity = {
    character_id: characterId, name: ref.name, display_name: person, metron_id: ref.metron_id ?? null,
    gcd_key: ref.gcd_key ?? null, publisher_id: publisherId ?? null, words: words(person, ref.name, mantle),
  };
  identity.id = await d.identities.add(identity);
  return { identity, created: true };
}

export async function ensureTeam(ref: { metron_id?: number | null; gcd_key?: string | null; name: string },
                                 publisherId?: Id | null): Promise<{ team: Team; created: boolean }> {
  const d = db();
  if (ref.metron_id != null) {
    const hit = await d.teams.where("metron_id").equals(ref.metron_id).first();
    if (hit) return { team: hit, created: false };
  }
  if (ref.gcd_key) {
    const hit = await d.teams.where("gcd_key").equals(ref.gcd_key).first();
    if (hit) return { team: hit, created: false };
  }
  const lower = ref.name.toLowerCase();
  const byName = (await d.teams.where("name").equals(ref.name).toArray())
    .concat(await d.teams.filter((t) => t.name.toLowerCase() === lower).toArray())
    .find((t) => !publisherId || !t.publisher_id || t.publisher_id === publisherId);
  if (byName) {
    const patch: Partial<Team> = {};
    if (ref.metron_id != null && byName.metron_id == null) patch.metron_id = ref.metron_id;
    if (ref.gcd_key && !byName.gcd_key) patch.gcd_key = ref.gcd_key;
    if (Object.keys(patch).length) await d.teams.update(byName.id!, patch);
    return { team: { ...byName, ...patch }, created: false };
  }
  const team: Team = { name: ref.name, metron_id: ref.metron_id ?? null, gcd_key: ref.gcd_key ?? null,
    publisher_id: publisherId ?? null, words: words(ref.name) };
  team.id = await d.teams.add(team);
  return { team, created: true };
}

/** Main when the series is named after the mantle or person; otherwise supporting. */
export async function addAppearance(issueId: Id, identity: Identity, role?: AppearanceRole | null): Promise<void> {
  const d = db();
  if (await d.appearances.get([issueId, identity.id!])) return;
  let finalRole = role ?? null;
  if (!finalRole) {
    const issue = await d.issues.get(issueId);
    const series = issue ? await d.series.get(issue.series_id) : undefined;
    const character = await d.characters.get(identity.character_id);
    const title = (series?.name ?? "").toLowerCase();
    const names = [character?.name, identity.display_name].filter(Boolean).map((n) => n!.toLowerCase());
    finalRole = names.some((n) => n && title.includes(n)) ? "main" : "supporting";
  }
  await d.appearances.put({ issue_id: issueId, identity_id: identity.id!, role: finalRole, role_source: role ? "gcd" : "derived" });
}

export async function addTeamAppearance(issueId: Id, teamId: Id): Promise<void> {
  if (!(await db().teamAppearances.get([issueId, teamId]))) await db().teamAppearances.put({ issue_id: issueId, team_id: teamId });
}

export async function addAffiliation(identityId: Id, teamId: Id, source: "metron" | "comicvine" | "gcd"): Promise<void> {
  if (!(await db().teamAffiliations.get([identityId, teamId]))) await db().teamAffiliations.put({ identity_id: identityId, team_id: teamId, source });
}

export const stamp = nowIso;
