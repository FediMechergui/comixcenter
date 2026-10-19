/**
 * Background sync jobs on the phone (port of backend/comix/ingest/jobs.py). Jobs live in
 * IndexedDB so they survive the app being closed. Each source has its own lane, so GCD's slow
 * pacing never holds up Metron or local work. A rate-limited job is deferred, not failed.
 */
import { AuthError, RateLimitError } from "./contracts";
import { comicvineConfigured, getComicVine, getGcd, getMetron, getCredentials, metronConfigured, NotConfiguredError } from "./clients";
import { db, nowIso, type Id, type Job } from "./db";
import * as cvSync from "./sync/comicvine";
import * as gcdSync from "./sync/gcd";
import * as metronSync from "./sync/metron";
import { tokenSortRatio } from "./parsing";
import { deriveMemberships } from "./services/teams";

export const P_USER = 50;     // something a person asked for
export const P_DETAIL = 110;  // per-issue detail after a series/arc sync
export const P_ENRICH = 150;  // Comic Vine enrichment
export const P_DERIVE = 160;  // local derivations

type Ctx = { job: Job; progress: (m: string) => void; enqueue: (kind: string, payload: Record<string, unknown>, priority: number) => Promise<void> };
type Handler = (ctx: Ctx, payload: Record<string, any>) => Promise<Record<string, unknown>>; // eslint-disable-line @typescript-eslint/no-explicit-any

function dedupeKey(kind: string, payload: Record<string, unknown>) {
  const sorted = Object.keys(payload).sort().reduce<Record<string, unknown>>((o, k) => { o[k] = payload[k]; return o; }, {});
  return `${kind}:${JSON.stringify(sorted)}`.slice(0, 300);
}

const listeners = new Set<(job: Job) => void>();
/** Called after every job finishes, so screens can refresh. */
export function onJobFinished(cb: (job: Job) => void) { listeners.add(cb); return () => listeners.delete(cb); }

export async function enqueue(kind: string, payload: Record<string, unknown> = {}, priority = P_USER): Promise<Job> {
  if (!HANDLERS[kind]) throw new Error(`Unknown job kind ${kind}`);
  const d = db();
  const key = dedupeKey(kind, payload);
  const existing = (await d.jobs.where("dedupe_key").equals(key).toArray()).find((j) => j.status === "queued" || j.status === "running");
  if (existing) {
    if (priority < existing.priority) await d.jobs.update(existing.id!, { priority });
    return existing;
  }
  const job: Job = { kind, payload, dedupe_key: key, status: "queued", priority, attempts: 0, created_at: nowIso() };
  job.id = await d.jobs.add(job);
  wake();
  return job;
}

async function afterIssueDetail(ctx: Ctx, result: { issue_id: Id; new_identity_ids?: Id[]; new_team_ids?: Id[] }) {
  const d = db();
  for (const id of result.new_identity_ids ?? []) {
    const ident = await d.identities.get(id);
    if (ident?.metron_id) await ctx.enqueue("metron.character", { metron_id: ident.metron_id, with_issues: false }, P_ENRICH);
  }
  for (const id of result.new_team_ids ?? []) {
    const team = await d.teams.get(id);
    if (team?.metron_id) await ctx.enqueue("metron.team", { metron_id: team.metron_id, with_issues: false }, P_ENRICH);
  }
  const issue = await d.issues.get(result.issue_id);
  if (issue?.cv_id) await ctx.enqueue("comicvine.issue", { issue_id: result.issue_id }, P_ENRICH + 10);
}

const HANDLERS: Record<string, Handler> = {
  "metron.publishers": async (ctx) => metronSync.syncPublishers(await getMetron(), ctx.progress),
  "metron.series": async (ctx, p) => {
    const r = await metronSync.syncSeries(await getMetron(), Number(p.metron_id), ctx.progress);
    if (p.deep !== false) {
      const done = new Set((await db().issues.where("metron_id").anyOf(r.issue_metron_ids).toArray()).filter((i) => i.deep_synced_at).map((i) => i.metron_id));
      for (const mid of r.issue_metron_ids) if (!done.has(mid)) await ctx.enqueue("metron.issue", { metron_id: mid }, P_DETAIL);
    }
    await ctx.enqueue("library.rematch", {}, P_DERIVE);
    const { issue_metron_ids: _drop, ...rest } = r; void _drop;
    return rest;
  },
  "metron.issue": async (ctx, p) => {
    const r = await metronSync.syncIssue(await getMetron(), Number(p.metron_id), ctx.progress);
    await afterIssueDetail(ctx, r);
    return r;
  },
  "metron.issue_by_cv": async (ctx, p) => {
    const api = await getMetron();
    const matches = await api.issuesList({ cv_id: Number(p.cv_id) });
    if (!matches.length) return { found: false };
    const r = await metronSync.syncIssue(api, matches[0].id, ctx.progress);
    const d = db();
    const issue = await d.issues.get(r.issue_id);
    for (const ev of await d.characterEvents.where("cv_issue_id").equals(issue!.cv_id!).toArray()) {
      await d.characterEvents.update(ev.id!, { issue_id: issue!.id });
      if (ev.kind === "first_appearance") {
        const ident = await d.identities.get(ev.identity_id);
        if (ident && !ident.first_appearance_issue_id) await d.identities.update(ident.id!, { first_appearance_issue_id: issue!.id });
      }
    }
    return { found: true, ...r };
  },
  "metron.arc": async (ctx, p) => {
    const r = await metronSync.syncArc(await getMetron(), Number(p.metron_id), ctx.progress);
    if (p.deep !== false) for (const mid of r.issue_metron_ids) await ctx.enqueue("metron.issue", { metron_id: mid }, P_DETAIL);
    if ((await db().arcs.get(r.arc_id))?.cv_id) await ctx.enqueue("comicvine.arc", { arc_id: r.arc_id }, P_ENRICH);
    const { issue_metron_ids: _drop, ...rest } = r; void _drop;
    return rest;
  },
  "metron.character": async (ctx, p) => {
    const r = await metronSync.syncCharacter(await getMetron(), Number(p.metron_id), p.with_issues !== false, ctx.progress);
    if ((await db().identities.get(r.identity_id))?.cv_id) await ctx.enqueue("comicvine.identity", { identity_id: r.identity_id }, P_ENRICH);
    return r;
  },
  "metron.team": async (ctx, p) => {
    const r = await metronSync.syncTeam(await getMetron(), Number(p.metron_id), p.with_issues !== false, ctx.progress);
    if ((await db().teams.get(r.team_id))?.cv_id) await ctx.enqueue("comicvine.team", { team_id: r.team_id }, P_ENRICH);
    await ctx.enqueue("teams.derive", { team_id: r.team_id }, P_DERIVE);
    return r;
  },
  "metron.reading_list": async (ctx, p) => metronSync.syncReadingList(await getMetron(), Number(p.metron_id), ctx.progress),
  // Library lookup: Metron when connected, otherwise the keyless GCD
  "metron.find_series": async (ctx, p) => {
    if (!metronConfigured(await getCredentials())) {
      await ctx.enqueue("gcd.find_series", p, P_USER);
      return { delegated: "gcd" };
    }
    const api = await getMetron();
    const name = String(p.name), year = p.year ? Number(p.year) : null;
    const candidates = (await metronSync.search(api, "series", name, year)) as { metron_id: number; name: string; year_began?: number }[];
    const pick = best(candidates.map((c) => ({ id: c.metron_id, name: c.name.split(" (")[0], year: c.year_began ?? null })), name, year);
    if (!pick) return { found: false };
    await ctx.enqueue("metron.series", { metron_id: pick.id, deep: !!p.deep }, P_USER);
    return { found: true, metron_id: pick.id, name: pick.name };
  },
  "gcd.series": async (ctx, p) => {
    const r = await gcdSync.syncGcdSeries((await getGcd()), Number(p.gcd_id), ctx.progress);
    if (p.deep !== false) {
      const done = new Set((await db().issues.where("gcd_id").anyOf(r.issue_gcd_ids).toArray()).filter((i) => i.deep_synced_at).map((i) => i.gcd_id));
      for (const gid of r.issue_gcd_ids) if (!done.has(gid)) await ctx.enqueue("gcd.issue", { gcd_id: gid }, P_DETAIL);
    }
    if (comicvineConfigured(await getCredentials())) await ctx.enqueue("comicvine.series_covers", { series_id: r.series_id }, P_USER);
    await ctx.enqueue("library.rematch", {}, P_DERIVE);
    const { issue_gcd_ids: _drop, ...rest } = r; void _drop;
    return rest;
  },
  "gcd.issue": async (ctx, p) => {
    const r = await gcdSync.syncGcdIssue((await getGcd()), Number(p.gcd_id), ctx.progress);
    if ("issue_id" in r) {
      const teams = await db().teamAppearances.where("issue_id").equals(r.issue_id as Id).toArray();
      for (const t of teams) await ctx.enqueue("teams.derive", { team_id: t.team_id }, P_DERIVE);
    }
    return r;
  },
  "gcd.find_series": async (ctx, p) => {
    const name = String(p.name), year = p.year ? Number(p.year) : null;
    let found = await gcdSync.searchGcd((await getGcd()), name, year);
    if (!found.length && year) found = await gcdSync.searchGcd((await getGcd()), name);
    const pick = best(found.map((s) => ({ id: s.gcd_id as number, name: s.name as string, year: (s.year_began as number) ?? null })), name, year);
    if (!pick) return { found: false };
    await ctx.enqueue("gcd.series", { gcd_id: pick.id, deep: false }, P_USER);
    return { found: true, gcd_id: pick.id, name: pick.name };
  },
  "comicvine.identity": async (ctx, p) => {
    const r = await cvSync.enrichIdentity(await getComicVine(), Number(p.identity_id));
    const ident = await db().identities.get(Number(p.identity_id));
    const cvFirst = r.first_appearance_cv_issue_id as number | undefined;
    if (cvFirst && ident && !ident.first_appearance_issue_id && metronConfigured(await getCredentials())) {
      await ctx.enqueue("metron.issue_by_cv", { cv_id: cvFirst }, P_ENRICH + 5);
    }
    return r;
  },
  "comicvine.team": async (ctx, p) => {
    const r = await cvSync.enrichTeam(await getComicVine(), Number(p.team_id));
    await ctx.enqueue("teams.derive", { team_id: Number(p.team_id) }, P_DERIVE);
    return r;
  },
  "comicvine.series": async (ctx, p) => {
    const r = await cvSync.syncCvSeries(await getComicVine(), Number(p.cv_id), ctx.progress);
    await ctx.enqueue("gcd.link_series", { series_id: r.series_id }, P_ENRICH);
    await ctx.enqueue("library.rematch", {}, P_DERIVE);
    return r;
  },
  "comicvine.issue_full": async (ctx, p) => {
    const r = await cvSync.syncCvIssue(await getComicVine(), Number(p.issue_id));
    if ("issue_id" in r) {
      for (const t of await db().teamAppearances.where("issue_id").equals(r.issue_id as Id).toArray()) {
        await ctx.enqueue("teams.derive", { team_id: t.team_id }, P_DERIVE);
      }
    }
    return r;
  },
  "gcd.link_series": async (_ctx, p) => gcdSync.linkGcdSeries(await getGcd(), Number(p.series_id)),
  "comicvine.series_covers": async (_ctx, p) => cvSync.syncSeriesCovers(await getComicVine(), Number(p.series_id)),
  "comicvine.arc": async (_ctx, p) => cvSync.enrichArc(await getComicVine(), Number(p.arc_id)),
  "comicvine.issue": async (_ctx, p) => cvSync.enrichIssue(await getComicVine(), Number(p.issue_id)),
  "teams.derive": async (_ctx, p) => deriveMemberships(Number(p.team_id)),
  "library.rematch": async (_ctx, p) => {
    const { rematchUnmatched } = await import("./matching");
    return rematchUnmatched(p.file_ids as Id[] | undefined);
  },
};

export const JOB_KINDS = Object.keys(HANDLERS);

/** Closest name match above the bar; the year breaks ties between relaunches. */
function best<T extends { id: number; name: string; year: number | null }>(cands: T[], name: string, year: number | null): T | undefined {
  const score = (c: T) => tokenSortRatio(name, c.name) - (year && c.year ? Math.min(Math.abs(year - c.year), 10) * 3 : 0);
  const top = cands.slice().sort((a, b) => score(b) - score(a))[0];
  return top && score(top) >= 70 ? top : undefined;
}

function lane(kind: string): string {
  const prefix = kind.split(".")[0];
  return prefix === "metron" || prefix === "comicvine" || prefix === "gcd" ? prefix : "local";
}

function retryAfter(e: unknown): number | null {
  if (e instanceof RateLimitError) return Math.max(5, e.retryAfterSeconds || 60);
  return null;
}

async function claim(laneName: string): Promise<Job | undefined> {
  const d = db();
  const now = nowIso();
  return d.transaction("rw", d.jobs, async () => {
    const candidates = (await d.jobs.where("status").equals("queued").toArray())
      .filter((j) => lane(j.kind) === laneName && (!j.run_after || j.run_after <= now))
      .sort((a, b) => a.priority - b.priority || a.id! - b.id!);
    const job = candidates[0];
    if (!job) return undefined;
    await d.jobs.update(job.id!, { status: "running", started_at: now, attempts: job.attempts + 1 });
    return { ...job, status: "running" as const, attempts: job.attempts + 1 };
  });
}

export async function runJob(job: Job): Promise<Job["status"]> {
  const d = db();
  const ctx: Ctx = {
    job,
    progress: (m) => { d.jobs.update(job.id!, { progress: m.slice(0, 300) }); },
    enqueue: async (kind, payload, priority) => { await enqueue(kind, payload, priority); },
  };
  let finished: Job;
  try {
    const result = await HANDLERS[job.kind](ctx, job.payload as Record<string, unknown>);
    finished = { ...job, status: "done", result, error: null, finished_at: nowIso() };
  } catch (e) {
    const wait = retryAfter(e);
    if (wait !== null) {
      finished = { ...job, status: "queued", run_after: new Date(Date.now() + wait * 1000).toISOString(),
        error: `Rate limited; retrying after ${Math.round(wait)}s: ${(e as Error).message}` };
    } else {
      const err = e as Error;
      const message = e instanceof NotConfiguredError || e instanceof AuthError ? err.message : `${err.name}: ${err.message}`;
      finished = { ...job, status: "failed", error: message.slice(0, 2000), finished_at: nowIso() };
    }
  }
  const { progress } = (await d.jobs.get(job.id!)) ?? {};
  await d.jobs.put({ ...finished, progress: progress ?? finished.progress ?? null });
  for (const cb of listeners) try { cb(finished); } catch { /* listener errors don't stop the queue */ }
  return finished.status;
}

/** Runs queued jobs in order until none are runnable (tests, and draining on demand). */
export async function runPending(limit = Infinity): Promise<number> {
  let ran = 0;
  while (ran < limit) {
    let job: Job | undefined;
    for (const l of ["local", "metron", "comicvine", "gcd"]) { job = await claim(l); if (job) break; }
    if (!job) break;
    await runJob(job);
    ran++;
  }
  return ran;
}

export async function requeueInterrupted(): Promise<number> {
  const d = db();
  const running = await d.jobs.where("status").equals("running").toArray();
  for (const j of running) await d.jobs.update(j.id!, { status: "queued" });
  return running.length;
}

// ── Worker: one loop per lane while the app is open ──
let started = false;
let generation = 0;
const wakers = new Set<() => void>();
const busy = new Map<string, number | null>();

function wake() { for (const w of wakers) w(); }

export function workerStatus() {
  return { running: started, current: [...busy.values()].filter((v): v is number => v != null) };
}

export function startWorker() {
  if (started) return;
  started = true;
  const currentGeneration = ++generation;
  requeueInterrupted().finally(() => {
    if (started && generation === currentGeneration) for (const l of ["local", "metron", "comicvine", "gcd"]) laneLoop(l, currentGeneration);
  });
}

async function laneLoop(laneName: string, currentGeneration: number) {
  while (started && generation === currentGeneration) {
    let job: Job | undefined;
    try { job = await claim(laneName); } catch { job = undefined; }
    if (!started || generation !== currentGeneration) {
      if (job) await db().jobs.update(job.id!, { status: "queued" });
      return;
    }
    if (!job) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, 5000);
        function done() { clearTimeout(t); wakers.delete(done); resolve(); }
        wakers.add(done);
      });
      continue;
    }
    busy.set(laneName, job.id!);
    try { await runJob(job); } finally { busy.set(laneName, null); }
  }
}

export function stopWorker() { started = false; generation++; wake(); }
