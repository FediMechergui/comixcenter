/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Comic Vine enrichment (port of backend/comix/ingest/comicvine_sync.py): real names, aliases,
 * first appearances, deaths, team rosters, disbandings, arc text. Objects use simyan's attribute
 * names (real_name, first_issue, deaths, members, issues_disbanded_in, ...).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { db, nowIso, type Id, type Identity } from "../db";
import { stripHtml, words } from "../parsing";
import { addAffiliation } from "./upserts";

export interface ComicVineApi {
  getCharacter(id: number): Promise<any>;
  getIssue(id: number): Promise<any>;
  getTeam(id: number): Promise<any>;
  getStoryArc(id: number): Promise<any>;
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
