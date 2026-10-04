/**
 * Story arcs, events, tiered reading orders, the prerequisite graph and read progress
 * (port of backend/comix/services/orders.py). Paths: essential → Essential; core → + Recommended;
 * complete → everything but Skip; all → everything.
 */
import { db, nowIso, type Arc, type Entry, type Id, type Issue, type OrderKind, type ReadingOrder, type Tier } from "../db";
import { slugify, words } from "../parsing";
import { COLLECTED_TYPES, issueCards, readIds } from "./catalog";

export type PathName = "essential" | "core" | "complete" | "all";
export const TIER_ORDER: Tier[] = ["essential", "recommended", "tie_in", "optional", "skip"];
export const PATHS: Record<PathName, Tier[]> = {
  essential: ["essential"], core: ["essential", "recommended"],
  complete: ["essential", "recommended", "tie_in", "optional"], all: TIER_ORDER,
};

const byDate = (a: Issue, b: Issue) => (a.cover_date ?? "9999").localeCompare(b.cover_date ?? "9999") || a.number_sort - b.number_sort;

export async function arcIssueRows(arcId: Id) {
  const d = db();
  const links = await d.arcIssues.where("arc_id").equals(arcId).toArray();
  const issues = await d.issues.bulkGet(links.map((l) => l.issue_id));
  return links.map((l, i) => ({ link: l, issue: issues[i]! })).filter((r) => r.issue)
    .sort((a, b) => a.link.position - b.link.position || byDate(a.issue, b.issue));
}

export async function arcSummary(arc: Arc) {
  const rows = await arcIssueRows(arc.id!);
  const dates = rows.map((r) => r.issue.cover_date).filter(Boolean).sort() as string[];
  const read = await readIds(rows.map((r) => r.issue.id!));
  return { id: arc.id!, name: arc.name, kind: arc.kind, image_url: arc.image_url ?? rows[0]?.issue.image_url ?? null,
    issue_count: rows.length, read_count: read.size, start_date: dates[0] ?? null, end_date: dates[dates.length - 1] ?? null };
}

export async function listArcs(q?: string | null, kind?: string | null, publisherId?: number | null, page = 1, size = 50) {
  let arcs = await db().arcs.toArray();
  if (q) { const l = q.trim().toLowerCase(); arcs = arcs.filter((a) => a.name.toLowerCase().includes(l)); }
  if (kind) arcs = arcs.filter((a) => a.kind === kind);
  if (publisherId) arcs = arcs.filter((a) => a.publisher_id === publisherId);
  const summaries = await Promise.all(arcs.map(arcSummary));
  summaries.sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? "") || a.name.localeCompare(b.name));
  return { items: summaries.slice((page - 1) * size, page * size), total: summaries.length, page, size };
}

async function linked(arcId: Id, kind: "prerequisite" | "leads_into", outgoing: boolean) {
  const d = db();
  const links = outgoing ? await d.arcLinks.where("arc_id").equals(arcId).toArray() : await d.arcLinks.where("target_arc_id").equals(arcId).toArray();
  const out = [];
  for (const l of links.filter((x) => x.kind === kind)) {
    const other = await d.arcs.get(outgoing ? l.target_arc_id : l.arc_id);
    if (other) out.push({ ...(await arcSummary(other)), note: l.note ?? null, source: l.source, link_id: l.id! });
  }
  return out;
}

/** Derived suggestion: the next arc in the same series after this one ends. */
type ArcSummary = Awaited<ReturnType<typeof arcSummary>>;

async function nextInSeries(arc: Arc): Promise<ArcSummary[]> {
  const d = db();
  const rows = await arcIssueRows(arc.id!);
  const lastBySeries = new Map<Id, string>();
  for (const { issue } of rows) if (issue.cover_date && (lastBySeries.get(issue.series_id) ?? "") < issue.cover_date) lastBySeries.set(issue.series_id, issue.cover_date);
  const out: ArcSummary[] = [];
  for (const [seriesId, end] of lastBySeries) {
    const seriesIssues = await d.issues.where("series_id").equals(seriesId).primaryKeys();
    const firstDates = new Map<Id, string>();
    for (const ai of seriesIssues.length ? await d.arcIssues.where("issue_id").anyOf(seriesIssues).toArray() : []) {
      if (ai.arc_id === arc.id) continue;
      const iss = await d.issues.get(ai.issue_id);
      if (iss?.cover_date && (!firstDates.has(ai.arc_id) || iss.cover_date < firstDates.get(ai.arc_id)!)) firstDates.set(ai.arc_id, iss.cover_date);
    }
    const next = [...firstDates].filter(([, date]) => date > end).sort((a, b) => a[1].localeCompare(b[1]))[0];
    if (next && !out.some((o) => o.id === next[0])) {
      const a = await d.arcs.get(next[0]);
      if (a) out.push(await arcSummary(a));
    }
  }
  return out;
}

export async function arcDetail(arcId: Id) {
  const d = db();
  const arc = await d.arcs.get(arcId);
  if (!arc) return null;
  const rows = await arcIssueRows(arcId);
  const cards = new Map((await issueCards(rows.map((r) => r.issue))).map((c) => [c.id, c]));
  type Row = Awaited<ReturnType<typeof issueCards>>[number] & { role: "core" | "tie_in"; tier: Tier | null; position: number };
  const core: Row[] = [], tieIns: Row[] = [];
  for (const { link, issue } of rows) {
    const card = { ...cards.get(issue.id!)!, role: link.role, tier: link.tier ?? null, position: link.position };
    (link.role === "core" ? core : tieIns).push(card);
  }
  const issueIds = rows.map((r) => r.issue.id!);
  const byRole = new Map<string, Map<Id, { id: Id; name: string; issues: number }>>();
  for (const c of issueIds.length ? await d.credits.where("issue_id").anyOf(issueIds).toArray() : []) {
    const creator = await d.creators.get(c.creator_id);
    if (!creator) continue;
    if (!byRole.has(c.role)) byRole.set(c.role, new Map());
    const m = byRole.get(c.role)!;
    m.set(creator.id!, { id: creator.id!, name: creator.name, issues: (m.get(creator.id!)?.issues ?? 0) + 1 });
  }
  const rank = (r: string) => [/writer/i.test(r) ? 0 : /artist|pencil/i.test(r) ? 1 : 2, r] as const;
  const roles = [...byRole.keys()].sort((a, b) => { const [x, y] = [rank(a), rank(b)]; return x[0] - y[0] || x[1].localeCompare(y[1]); });
  const collections = new Map<Id, number>();
  for (const c of issueIds.length ? await d.collected.where("issue_id").anyOf(issueIds).toArray() : []) {
    collections.set(c.collection_issue_id, (collections.get(c.collection_issue_id) ?? 0) + 1);
  }
  const collected = [];
  for (const [cid, n] of [...collections].sort((a, b) => b[1] - a[1])) {
    const c = await d.issues.get(cid);
    if (!c) continue;
    const s = await d.series.get(c.series_id);
    collected.push({ issue_id: c.id!, title: `${s?.name ?? ""}${c.number !== "1" && c.number !== "?" ? ` #${c.number}` : ""}`,
      series_type: s?.series_type ?? null, image_url: c.image_url ?? null, covers: n, of: rows.length });
  }
  const orders = [];
  for (const e of await d.entries.where("arc_id").equals(arcId).toArray()) {
    const o = await d.readingOrders.get(e.order_id);
    if (o) orders.push({ id: o.id!, name: o.name, tier: e.tier });
  }
  return {
    ...(await arcSummary(arc)), description: arc.description ?? null, metron_id: arc.metron_id ?? null, cv_id: arc.cv_id ?? null,
    core_issues: core, tie_ins: tieIns,
    creators: roles.map((r) => ({ role: r, creators: [...byRole.get(r)!.values()].sort((a, b) => b.issues - a.issues).slice(0, 6) })),
    collected_editions: collected,
    prerequisites: await linked(arcId, "prerequisite", true), required_by: await linked(arcId, "prerequisite", false),
    leads_into: await linked(arcId, "leads_into", true), follows: await linked(arcId, "leads_into", false),
    continues_in: await nextInSeries(arc), reading_orders: orders,
  };
}

// ── Prerequisite graph ──

/** Every arc reachable through "requires" links, with its longest distance from the target. */
async function prerequisiteDepths(arcId: Id, maxDepth = 25): Promise<Map<Id, number>> {
  const d = db();
  const all = (await d.arcLinks.toArray()).filter((l) => l.kind === "prerequisite");
  const requires = new Map<Id, Id[]>();
  for (const l of all) requires.set(l.arc_id, [...(requires.get(l.arc_id) ?? []), l.target_arc_id]);
  const depth = new Map<Id, number>();
  let frontier: [Id, number][] = (requires.get(arcId) ?? []).map((t) => [t, 1]);
  while (frontier.length) {
    const nextFrontier: [Id, number][] = [];
    for (const [node, dist] of frontier) {
      if (node === arcId || dist > maxDepth) continue;
      if ((depth.get(node) ?? 0) >= dist) continue;
      depth.set(node, dist);
      for (const t of requires.get(node) ?? []) nextFrontier.push([t, dist + 1]);
    }
    frontier = nextFrontier;
  }
  return depth;
}

/** "What do I need before X?" — the prerequisites in a valid reading sequence, plus the edges. */
export async function prerequisitePlan(arcId: Id) {
  const d = db();
  const target = await d.arcs.get(arcId);
  if (!target) return null;
  const depth = await prerequisiteDepths(arcId);
  const arcs = (await d.arcs.bulkGet([...depth.keys()])).filter(Boolean) as Arc[];
  const sequence = await Promise.all(arcs.map(async (a) => {
    const s = await arcSummary(a);
    return { ...s, depth: depth.get(a.id!)!, done: s.issue_count > 0 && s.read_count >= s.issue_count };
  }));
  sequence.sort((a, b) => b.depth - a.depth || (a.start_date ?? "9999").localeCompare(b.start_date ?? "9999") || a.name.localeCompare(b.name));
  const nodes = new Set([...depth.keys(), arcId]);
  const edges = (await d.arcLinks.toArray()).filter((l) => l.kind === "prerequisite" && nodes.has(l.arc_id) && nodes.has(l.target_arc_id))
    .map((l) => ({ from: l.arc_id, to: l.target_arc_id, note: l.note ?? null }));
  const remaining = sequence.filter((s) => !s.done);
  return { target: await arcSummary(target), sequence, edges, remaining_arcs: remaining.length,
    remaining_issues: remaining.reduce((n, s) => n + s.issue_count - s.read_count, 0) };
}

export async function wouldCreateCycle(arcId: Id, requiresArcId: Id): Promise<boolean> {
  if (arcId === requiresArcId) return true;
  return (await prerequisiteDepths(requiresArcId, 50)).has(arcId);
}

// ── Reading orders ──

export async function orderEntries(orderId: Id): Promise<Entry[]> {
  return (await db().entries.where("order_id").equals(orderId).toArray()).sort((a, b) => a.position - b.position || a.id! - b.id!);
}

/** Issue ids each entry stands for (an arc entry covers all of its issues). */
async function entryIssueIds(entries: Entry[]): Promise<Map<Id, Id[]>> {
  const out = new Map<Id, Id[]>();
  const arcMap = new Map<Id, Id[]>();
  for (const arcId of new Set(entries.filter((e) => e.arc_id).map((e) => e.arc_id!))) {
    arcMap.set(arcId, (await arcIssueRows(arcId)).map((r) => r.issue.id!));
  }
  for (const e of entries) out.set(e.id!, e.issue_id ? [e.issue_id] : arcMap.get(e.arc_id!) ?? []);
  return out;
}

export async function orderProgress(order: ReadingOrder) {
  const entries = await orderEntries(order.id!);
  const covered = await entryIssueIds(entries);
  const read = await readIds([...new Set([...covered.values()].flat())]);
  const paths = {} as Record<PathName, { issues: number; read: number }>;
  for (const [path, tiers] of Object.entries(PATHS) as [PathName, Tier[]][]) {
    const ids = new Set(entries.filter((e) => tiers.includes(e.tier)).flatMap((e) => covered.get(e.id!) ?? []));
    paths[path] = { issues: ids.size, read: [...ids].filter((i) => read.has(i)).length };
  }
  return { entries: entries.length, paths };
}

export async function orderCard(order: ReadingOrder) {
  return {
    id: order.id!, name: order.name, slug: order.slug, kind: order.kind, source: order.source, description: order.description ?? null,
    universe_id: order.universe_id ?? null, era_id: order.era_id ?? null, character_id: order.character_id ?? null,
    team_id: order.team_id ?? null, arc_id: order.arc_id ?? null, creator_id: order.creator_id ?? null,
    updated_at: order.updated_at, progress: await orderProgress(order),
  };
}

export async function listOrders(f: { kind?: string | null; universe_id?: number | null; character_id?: number | null; team_id?: number | null;
  arc_id?: number | null; creator_id?: number | null; q?: string | null }) {
  let orders = await db().readingOrders.toArray();
  for (const key of ["kind", "universe_id", "character_id", "team_id", "arc_id", "creator_id"] as const) {
    const v = f[key];
    if (v != null) orders = orders.filter((o) => o[key] === v);
  }
  if (f.q) { const l = f.q.toLowerCase(); orders = orders.filter((o) => o.name.toLowerCase().includes(l)); }
  orders.sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(orders.map(orderCard));
}

export async function orderDetail(orderId: Id, path: PathName = "core") {
  const d = db();
  const order = await d.readingOrders.get(orderId);
  if (!order) return null;
  const tiers = PATHS[path] ?? PATHS.core;
  const entries = await orderEntries(orderId);
  const covered = await entryIssueIds(entries);
  const allIds = [...new Set([...covered.values()].flat())];
  const read = await readIds(allIds);
  const issues = (await d.issues.bulkGet(allIds)).filter(Boolean) as Issue[];
  const cards = new Map((await issueCards(issues)).map((c) => [c.id, c]));
  const arcIds = [...new Set(entries.filter((e) => e.arc_id).map((e) => e.arc_id!))];
  const arcs = new Map((await d.arcs.bulkGet(arcIds)).filter(Boolean).map((a) => [a!.id!, a!]));
  const arcPrereqs = new Map<Id, Id[]>();
  for (const l of arcIds.length ? await d.arcLinks.where("arc_id").anyOf(arcIds).toArray() : []) {
    if (l.kind === "prerequisite") arcPrereqs.set(l.arc_id, [...(arcPrereqs.get(l.arc_id) ?? []), l.target_arc_id]);
  }
  const out = [];
  for (const e of entries) {
    if (!tiers.includes(e.tier)) continue;
    const ids = covered.get(e.id!) ?? [];
    const item: Record<string, unknown> = { id: e.id!, position: e.position, tier: e.tier, note: e.note ?? null,
      issue_count: ids.length, read_count: ids.filter((i) => read.has(i)).length };
    if (e.issue_id) Object.assign(item, { type: "issue", issue: cards.get(e.issue_id) });
    else {
      const a = arcs.get(e.arc_id!);
      Object.assign(item, { type: "arc", arc: a && { id: a.id!, name: a.name, kind: a.kind, image_url: a.image_url ?? null },
        issues: ids.map((i) => cards.get(i)).filter(Boolean) });
    }
    const prereqs: { type: "arc" | "issue"; id: Id; name: string | null }[] = [];
    for (const p of await d.entryPrereqs.where("entry_id").equals(e.id!).toArray()) {
      if (p.requires_arc_id) prereqs.push({ type: "arc", id: p.requires_arc_id, name: (await d.arcs.get(p.requires_arc_id))?.name ?? null });
      else if (p.requires_issue_id) {
        const c = cards.get(p.requires_issue_id) ?? (await issueCards([(await d.issues.get(p.requires_issue_id))!].filter(Boolean)))[0];
        prereqs.push({ type: "issue", id: p.requires_issue_id, name: c ? `${c.series_name} #${c.number}` : null });
      }
    }
    for (const t of arcPrereqs.get(e.arc_id ?? -1) ?? []) prereqs.push({ type: "arc", id: t, name: (await d.arcs.get(t))?.name ?? null });
    item.prerequisites = prereqs;
    item.done = (item.issue_count as number) > 0 && (item.read_count as number) >= (item.issue_count as number);
    out.push(item);
  }
  const nextUp = out.find((e) => !e.done);
  const tierCounts = Object.fromEntries(TIER_ORDER.map((t) => [t, entries.filter((e) => e.tier === t).length]));
  return { ...(await orderCard(order)), path, tiers, entries: out, next_entry_id: nextUp?.id ?? null, tier_counts: tierCounts };
}

// ── Progress ──

export async function setRead(issueIds: Id[], read: boolean): Promise<number> {
  const d = db();
  const ids = [...new Set(issueIds)];
  if (!ids.length) return 0;
  const already = await readIds(ids);
  if (read) {
    const now = nowIso();
    const fresh = ids.filter((i) => !already.has(i));
    await d.readStatus.bulkPut(fresh.map((issue_id) => ({ issue_id, read_at: now })));
    return fresh.length;
  }
  await d.readStatus.bulkDelete([...already]);
  return already.size;
}

export async function markOrderReadThrough(orderId: Id, entryId: Id, path: PathName = "core") {
  const tiers = PATHS[path] ?? PATHS.core;
  const entries = (await orderEntries(orderId)).filter((e) => tiers.includes(e.tier));
  const covered = await entryIssueIds(entries);
  const ids: Id[] = [];
  for (const e of entries) { ids.push(...(covered.get(e.id!) ?? [])); if (e.id === entryId) break; }
  return setRead(ids, true);
}

export async function progressSummary(limit = 12) {
  const d = db();
  const all = await d.readStatus.toArray();
  const recentIds = all.sort((a, b) => b.read_at.localeCompare(a.read_at)).slice(0, limit).map((r) => r.issue_id);
  const recent = (await d.issues.bulkGet(recentIds)).filter(Boolean) as Issue[];
  const inProgress = [];
  for (const o of await d.readingOrders.toArray()) {
    const p = (await orderProgress(o)).paths.core;
    if (p.read > 0 && p.read < p.issues) inProgress.push(await orderCard(o));
  }
  inProgress.sort((a, b) => b.progress.paths.core.read / Math.max(b.progress.paths.core.issues, 1) - a.progress.paths.core.read / Math.max(a.progress.paths.core.issues, 1));
  return { issues_read: all.length, recent: await issueCards(recent), orders_in_progress: inProgress.slice(0, limit) };
}

// ── Drafting orders for curation ──

async function uniqueSlug(name: string) {
  const base = slugify(name) || "order";
  let slug = base, n = 2;
  while (await db().readingOrders.where("slug").equals(slug).first()) slug = `${base}-${n++}`;
  return slug;
}

async function newOrder(name: string, kind: OrderKind, replace: boolean, refs: Partial<ReadingOrder>, description: string): Promise<ReadingOrder> {
  const d = db();
  const existing = (await d.readingOrders.where("kind").equals(kind).toArray()).find((o) => o.source === "generated"
    && (["universe_id", "era_id", "character_id", "team_id", "arc_id", "creator_id"] as const).every((k) => (o[k] ?? null) === (refs[k] ?? null)));
  if (existing && replace) {
    await d.entries.where("order_id").equals(existing.id!).delete();
    await d.readingOrders.update(existing.id!, { description, updated_at: nowIso() });
    return { ...existing, description };
  }
  const row: ReadingOrder = { name, slug: await uniqueSlug(name), kind, source: "generated", description, ...refs,
    created_at: nowIso(), updated_at: nowIso(), words: words(name) };
  row.id = await d.readingOrders.add(row);
  return row;
}

async function addEntries(orderId: Id, items: { issue_id?: Id; arc_id?: Id; tier: Tier }[]) {
  await db().entries.bulkAdd(items.map((it, position) => ({ order_id: orderId, position, issue_id: it.issue_id ?? null, arc_id: it.arc_id ?? null, tier: it.tier })));
}

async function arcsByFirstDate(arcIds: Id[]): Promise<{ arc: Arc; first: string | null }[]> {
  const out = [];
  for (const id of new Set(arcIds)) {
    const arc = await db().arcs.get(id);
    if (arc) out.push({ arc, first: (await arcSummary(arc)).start_date });
  }
  return out.sort((a, b) => (a.first ?? "9999").localeCompare(b.first ?? "9999") || a.arc.name.localeCompare(b.arc.name));
}

export async function generateEventOrder(arcId: Id, replace = true) {
  const arc = (await db().arcs.get(arcId))!;
  const order = await newOrder(`${arc.name} reading order`, "event", replace, { arc_id: arcId },
    `Every issue of ${arc.name} in reading order. Core issues are Essential; tie-ins are tiered.`);
  const rows = await arcIssueRows(arcId);
  await addEntries(order.id!, rows.map(({ link }) => ({ issue_id: link.issue_id, tier: link.role === "core" ? "essential" : (link.tier ?? "tie_in") })));
  return order;
}

export async function generateCharacterOrder(characterId: Id, replace = true) {
  const d = db();
  const character = (await d.characters.get(characterId))!;
  const order = await newOrder(`${character.name} reading order`, "character", replace, { character_id: characterId },
    `Draft generated from ${character.name}'s appearances: the arcs they anchor, plus key issues. Curate tiers in curate mode.`);
  const identityIds = (await d.identities.where("character_id").equals(characterId).toArray()).map((i) => i.id!);
  const apps = identityIds.length ? await d.appearances.where("identity_id").anyOf(identityIds).toArray() : [];
  const featured = new Map(apps.map((a) => [a.issue_id, a.role]));
  const keep: { arc: Arc; tier: Tier; first: string | null }[] = [];
  const arcIds = featured.size ? [...new Set((await d.arcIssues.where("issue_id").anyOf([...featured.keys()]).toArray()).map((a) => a.arc_id))] : [];
  for (const { arc, first } of await arcsByFirstDate(arcIds)) {
    const issueIds = (await arcIssueRows(arc.id!)).map((r) => r.issue.id!);
    const inArc = issueIds.filter((i) => featured.has(i));
    if (inArc.length * 2 < issueIds.length) continue;
    const main = inArc.filter((i) => featured.get(i) === "main").length;
    keep.push({ arc, first, tier: main * 2 >= issueIds.length || arc.kind === "event" ? "recommended" : "optional" });
  }
  const keyEvents = (identityIds.length ? await d.characterEvents.where("identity_id").anyOf(identityIds).toArray() : [])
    .filter((e) => e.issue_id && ["first_appearance", "death", "resurrection"].includes(e.kind));
  const items: { date: string; issue_id?: Id; arc_id?: Id; tier: Tier }[] = keep.map((k) => ({ date: k.first ?? "9999", arc_id: k.arc.id!, tier: k.tier }));
  for (const e of keyEvents) {
    const iss = await d.issues.get(e.issue_id!);
    if (iss && !items.some((x) => x.issue_id === iss.id)) items.push({ date: iss.cover_date ?? "9999", issue_id: iss.id!, tier: "essential" });
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  await addEntries(order.id!, items);
  return order;
}

export async function generateTeamOrder(teamId: Id, replace = true) {
  const d = db();
  const team = (await d.teams.get(teamId))!;
  const order = await newOrder(`${team.name} reading order`, "team", replace, { team_id: teamId },
    `Draft generated from ${team.name}'s appearances: arcs the team anchors, by date.`);
  const teamIssues = new Set((await d.teamAppearances.where("team_id").equals(teamId).toArray()).map((t) => t.issue_id));
  const arcIds = teamIssues.size ? [...new Set((await d.arcIssues.where("issue_id").anyOf([...teamIssues]).toArray()).map((a) => a.arc_id))] : [];
  const items: { arc_id: Id; tier: Tier }[] = [];
  for (const { arc } of await arcsByFirstDate(arcIds)) {
    const ids = (await arcIssueRows(arc.id!)).map((r) => r.issue.id!);
    const featured = ids.filter((i) => teamIssues.has(i)).length;
    if (featured > 0 && featured * 2 >= ids.length) items.push({ arc_id: arc.id!, tier: arc.kind === "event" ? "essential" : "recommended" });
  }
  await addEntries(order.id!, items);
  return order;
}

export async function generateWriterOrder(creatorId: Id, seriesId?: Id | null, replace = true) {
  const d = db();
  const creator = (await d.creators.get(creatorId))!;
  const series = seriesId ? await d.series.get(seriesId) : undefined;
  const name = series ? `${creator.name}'s ${series.name} run` : `${creator.name}: complete works`;
  const order = await newOrder(name, "writer", replace, { creator_id: creatorId }, `Every issue ${creator.name} wrote${series ? ` on ${series.name}` : ""}, by date.`);
  const ids = [...new Set((await d.credits.where("creator_id").equals(creatorId).toArray()).filter((c) => /writer/i.test(c.role)).map((c) => c.issue_id))];
  let issues = (await d.issues.bulkGet(ids)).filter(Boolean) as Issue[];
  if (series) issues = issues.filter((i) => i.series_id === series.id);
  issues.sort(byDate);
  const items = [];
  for (const i of issues) {
    const s = await d.series.get(i.series_id);
    items.push({ issue_id: i.id!, tier: (COLLECTED_TYPES.has((s?.series_type ?? "").toLowerCase()) ? "optional" : "recommended") as Tier });
  }
  await addEntries(order.id!, items);
  return order;
}

export async function generateUniverseOrder(universeId: Id, eraId?: Id | null, replace = true) {
  const d = db();
  const universe = (await d.universes.get(universeId))!;
  const era = eraId ? await d.eras.get(eraId) : undefined;
  const order = await newOrder(era ? `${universe.name}: ${era.name}` : `${universe.name}: master order`, "universe", replace,
    { universe_id: universeId, era_id: era?.id ?? null }, "Master chronological order of arcs and events, by first publication.");
  const seriesIds = new Set((await d.seriesUniverses.where("universe_id").equals(universeId).toArray()).map((su) => su.series_id));
  const arcIds = new Set<Id>();
  for (const ai of await d.arcIssues.toArray()) {
    const iss = await d.issues.get(ai.issue_id);
    if (!iss || !seriesIds.has(iss.series_id)) continue;
    if (era && (!iss.cover_date || iss.cover_date < era.start_date || (era.end_date && iss.cover_date > era.end_date))) continue;
    arcIds.add(ai.arc_id);
  }
  await addEntries(order.id!, (await arcsByFirstDate([...arcIds])).map(({ arc }) => ({ arc_id: arc.id!, tier: (arc.kind === "event" ? "essential" : "recommended") as Tier })));
  return order;
}
