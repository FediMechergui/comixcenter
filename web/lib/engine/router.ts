/**
 * Answers the app's /api requests on the phone, with the same paths and response shapes as the
 * FastAPI server (backend/comix/api), so every screen works unchanged in either mode. Adds
 * /api/device/* (credentials kept on the phone) and /api/online/* (search and add from GCD/Metron).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AuthError, NotFoundError, RateLimitError } from "./contracts";
import { comicvineConfigured, gcdAccountConfigured, getComicVine, getCredentials, getGcd, getMetron, getSavedCredentials, metronConfigured, NotConfiguredError, saveCredentials, transport, type Credentials } from "./clients";
import { base64Utf8 } from "./sources/http";
import { isRcoPage, rcoChapters, rcoFind, rcoPageBytes, rcoPages, rcoSlug } from "./sources/rco";
import { batcaveCatalog, batcaveChapters, batcavePages, batcaveImage, isBatcave } from "./sources/batcave";
import { GCD_API } from "./sources/gcd";
import { db, nowIso, type Id, type Tier } from "./db";
import { enqueue, onJobFinished, P_DERIVE, P_USER, runJob, workerStatus } from "./jobs";
import { importComic, listLibrary, fileCard, pagePanels, recordPosition, removeFile, ImportError } from "./libraryStore";
import { applyMatch } from "./matching";
import { slugify, words } from "./parsing";
import * as catalog from "./services/catalog";
import * as chars from "./services/characters";
import * as orders from "./services/orders";
import { search as localSearch } from "./services/search";
import { exportSnapshot, importSnapshot, SnapshotError } from "./snapshot";
import { applyStarterPack, starterArcNames } from "./services/starterPack";
import { deriveMemberships, sharedTeamHistory } from "./services/teams";
import * as cvSync from "./sync/comicvine";
import * as gcdSync from "./sync/gcd";
import * as metronSync from "./sync/metron";
import { parseOpdsFeed } from "./library";
import { importFromOpds, browseOpds, builtinFeed, builtinFeeds } from "./opdsClient";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const found = <T,>(v: T | null | undefined, what = "Not found"): T => { if (v == null) throw new HttpError(404, what); return v; };
const num = (v: string | null) => (v == null || v === "" ? null : Number(v));
const bool = (v: string | null) => v === "true" || v === "1";

type Req = { method: string; path: string; query: URLSearchParams; body: any };
type Route = [string, RegExp, (req: Req, m: RegExpMatchArray) => Promise<unknown>];
const routes: Route[] = [];
const route = (method: string, pattern: string, fn: Route[2]) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:(\w+)/g, "(-?\\d+)")}/?$`), fn]);

// ── System ──
route("GET", "/api/status", async () => {
  const d = db();
  const w = workerStatus();
  // The home screen waits on this, so the seven counts run together rather than one after another.
  const [creds, jobs, series, issues, arcs, characters, teams, reading_orders, library_files] = await Promise.all([
    getCredentials(), d.jobs.toArray(), d.series.count(), d.issues.count(), d.arcs.count(),
    d.characters.count(), d.teams.count(), d.readingOrders.count(), d.libraryFiles.count(),
  ]);
  return {
    version: "0.2.0", mode: "device",
    sources: { metron: metronConfigured(creds), comicvine: comicvineConfigured(creds), gcd: true },
    admin_protected: false,
    worker: { running: w.running, current_job_id: w.current[0] ?? null, queued: jobs.filter((j) => j.status === "queued").length,
      failed: jobs.filter((j) => j.status === "failed").length },
    counts: { series, issues, arcs, characters, teams, reading_orders, library_files },
    scan_dirs: [], lan_urls: [],
  };
});

// ── Device credentials ──
const mask = (v?: string | null) => (v ? `${"•".repeat(Math.max(0, Math.min(v.length - 4, 8)))}${v.slice(-4)}` : null);
route("GET", "/api/device/credentials", async () => {
  const c = await getCredentials();
  return { metron_token: mask(c.metron_token), metron_username: c.metron_username ?? null, metron_password: c.metron_password ? "set" : null,
    comicvine_key: mask(c.comicvine_key), gcd_username: c.gcd_username ?? null, gcd_password: c.gcd_password ? "set" : null,
    metron: metronConfigured(c), comicvine: comicvineConfigured(c), gcd_account: gcdAccountConfigured(c) };
});
route("PUT", "/api/device/credentials", async ({ body }) => {
  const current = await getSavedCredentials();
  const next: Credentials = { ...current };
  for (const k of ["metron_token", "metron_username", "metron_password", "comicvine_key", "gcd_username", "gcd_password"] as const) {
    if (k in body) next[k] = body[k] ? String(body[k]) : null;
  }
  await saveCredentials(next);
  return { metron: metronConfigured(next), comicvine: comicvineConfigured(next), gcd_account: gcdAccountConfigured(next) };
});
route("POST", "/api/device/test", async ({ body }) => {
  try {
    if (body.source === "metron") { const r = await (await getMetron()).publishersList({ page: 1 }); return { ok: true, detail: `Connected: ${r.length}+ publishers` }; }
    if (body.source === "comicvine") {
      const { getComicVine } = await import("./clients");
      await (await getComicVine()).getCharacter(1443);
      return { ok: true, detail: "Connected" };
    }
    const creds = await getCredentials();
    if (gcdAccountConfigured(creds)) {
      // Uncached request, so the account itself is checked
      const res = await transport()({ method: "GET", url: `${GCD_API}publisher/54/`, params: { format: "json" }, responseType: "json",
        headers: { Accept: "application/json", Authorization: `Basic ${base64Utf8(`${creds.gcd_username}:${creds.gcd_password}`)}` } });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: "Grand Comics Database rejected your username or password" };
      if (res.status === 429) return { ok: true, detail: "Signed in, but this account is rate-limited right now; try again later" };
      if (res.status !== 200) return { ok: false, detail: `Grand Comics Database answered HTTP ${res.status}` };
      return { ok: true, detail: "Signed in to the Grand Comics Database" };
    }
    const r = await (await getGcd()).searchSeries("Saga", 2012);
    return { ok: true, detail: `Connected: ${r.length} results` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
});

// ── Online: find and add from GCD / Metron ──
route("GET", "/api/online/search", async ({ query }) => {
  const q = (query.get("q") ?? "").trim();
  const year = num(query.get("year"));
  const kinds = (query.get("kinds") ?? "series").split(",");
  if (!q) return { gcd: [], metron: {} };
  const creds = await getCredentials();
  const out: { comicvine: unknown[]; gcd: unknown[]; gcd_searched: boolean; metron: Record<string, unknown[]>; errors: string[] } =
    { comicvine: [], gcd: [], gcd_searched: false, metron: {}, errors: [] };
  const tasks: Promise<void>[] = [];
  const searchGcd = () => { out.gcd_searched = true; return getGcd().then((api) => gcdSync.searchGcd(api, q, year)).then(async (rows) => {
    const have = new Map((await db().series.where("gcd_id").anyOf(rows.map((r) => r.gcd_id as number)).toArray()).map((s) => [s.gcd_id, s.id]));
    out.gcd = rows.slice(0, 40).map((r) => ({ ...r, in_catalog: have.has(r.gcd_id as number), local_id: have.get(r.gcd_id as number) ?? null }));
  }).catch((e) => {
    const hint = e instanceof RateLimitError && !gcdAccountConfigured(creds) ? " Sign in with a free comics.org account in Settings to get your own limit." : "";
    out.errors.push(`Grand Comics Database: ${(e as Error).message}.${hint}`.replace("..", "."));
  }); };
  // Comic Vine ranks by relevance and answers in about a second, so it leads when connected; GCD's
  // name search is alphabetical and slow, so it runs when Comic Vine has nothing or when asked for.
  if (kinds.includes("series")) tasks.push((async () => {
    if (comicvineConfigured(creds)) {
      try {
        const rows = await cvSync.searchCvVolumes(await getComicVine(), q);
        const have = new Map((await db().series.where("cv_id").anyOf(rows.map((r) => r.cv_id)).toArray()).map((s) => [s.cv_id, s.id]));
        out.comicvine = rows.map((r) => ({ ...r, in_catalog: have.has(r.cv_id), local_id: have.get(r.cv_id) ?? null }));
      } catch (e) { out.errors.push(`Comic Vine: ${(e as Error).message}`); }
    }
    if (!out.comicvine.length || query.get("gcd") === "1") await searchGcd();
  })());
  if (metronConfigured(creds)) {
    for (const kind of kinds) {
      tasks.push((async () => {
        const rows = await metronSync.search(await getMetron(), kind, q, year) as any[];
        out.metron[kind] = rows.slice(0, 40);
      })().catch((e) => { out.errors.push(`Metron: ${(e as Error).message}`); }));
    }
  }
  await Promise.all(tasks);
  return out;
});

/** Adds something found online: syncs the record now (so it can be opened), queues the details. */
route("POST", "/api/online/add", async ({ body }) => {
  const source = String(body.source), kind = String(body.kind), id = Number(body.id);
  // GCD throttles anonymous use hard (~15 requests, then most of an hour), so a GCD series brings
  // its issue list now and each issue's cover/details when it is opened. Metron fetches everything.
  const payload = source === "gcd" ? { gcd_id: id, deep: false } : source === "comicvine" ? { cv_id: id } : { metron_id: id, deep: true, with_issues: true };
  const job = await enqueue(`${source}.${kind}`, payload, P_USER);
  if (job.status === "queued") await runJob({ ...job, status: "running", attempts: job.attempts + 1 });
  const done = await db().jobs.get(job.id!);
  if (done?.status === "failed") throw new HttpError(502, done.error ?? "Sync failed");
  const r = (done?.result ?? {}) as Record<string, number>;
  const local = r.series_id ? { kind: "series", id: r.series_id } : r.arc_id ? { kind: "arc", id: r.arc_id }
    : r.character_id ? { kind: "character", id: r.character_id } : r.team_id ? { kind: "team", id: r.team_id }
      : r.order_id ? { kind: "order", id: r.order_id } : null;
  return { job_id: job.id, status: done?.status, local };
});

// ── Reading online ──
// The reader runs in the app: these answer with image URLs, never with a page to open elsewhere.
route("GET", "/api/online/catalog", ({ query }) => batcaveCatalog(query.get("q") || "", Math.max(1, num(query.get("page")) || 1)));
route("GET", "/api/online/read/find", async ({ query }) => {
  const series = query.get("series");
  if (!series) throw new HttpError(422, "Need a series to look for");
  const slug = await rcoFind(series, num(query.get("year")));
  if (!slug) throw new HttpError(404, "No online copy of that series");
  return { slug, chapter: query.get("number") };
});
route("GET", "/api/online/read/chapters", async ({ query }) => {
  if (isBatcave(query.get("url") || "")) return batcaveChapters(query.get("url")!);
  const slug = rcoSlug(query.get("url")) ?? query.get("slug");
  if (!slug) throw new HttpError(422, "No readable link for this book");
  return { slug, url: query.get("url") || `https://readcomicsonline.ru/comic/${slug}`, source: "rco", chapters: (await rcoChapters(slug)).map((c) => ({ id: c, title: `Issue ${c}`, number: c })) };
});
route("GET", "/api/online/read/pages", async ({ query }) => {
  if (isBatcave(query.get("url") || "")) return batcavePages(query.get("url")!, query.get("chapter") || "");
  const slug = rcoSlug(query.get("url")) ?? query.get("slug");
  const chapter = query.get("chapter");
  if (!slug || !chapter) throw new HttpError(422, "Need a comic and a chapter to read");
  const found = await rcoPages(slug, chapter);
  if (!found.pages.length) throw new HttpError(404, "That chapter is not readable online");
  return { ...found, url: query.get("url") || `https://readcomicsonline.ru/comic/${slug}`, source: "rco", chapters: [] };
});

route("GET", "/api/online/read/page", async ({ query }) => {
  const url = query.get("url") ?? "";
  if (/^https:\/\/img\.batcave\.biz\//i.test(url)) return batcaveImage(url);
  if (!isRcoPage(url)) throw new HttpError(422, "That is not a readable page");
  try { return await rcoPageBytes(url); }
  catch (e) { throw new HttpError(502, (e as Error).message); }
});

// ── Catalog ──
route("GET", "/api/publishers", () => catalog.listPublishers());
route("GET", "/api/universes", async () => Promise.all((await db().universes.orderBy("id").toArray()).map((u) => catalog.universeCard(u))));
route("GET", "/api/publishers/:id", async (_r, m) => found(await catalog.publisherDetail(+m[1]), "Publisher not found"));
route("GET", "/api/universes/:id", async (_r, m) => found(await catalog.universeDetail(+m[1]), "Universe not found"));
route("GET", "/api/series", ({ query: q }) => catalog.listSeries({
  publisher_id: num(q.get("publisher_id")), universe_id: num(q.get("universe_id")), era_id: num(q.get("era_id")), q: q.get("q"),
  unclassified: bool(q.get("unclassified")), collected: q.has("collected") ? bool(q.get("collected")) : null,
  sort: q.get("sort") ?? "name", page: num(q.get("page")) ?? 1, size: num(q.get("size")) ?? 50,
}));
route("GET", "/api/series/:id", async (_r, m) => found(await catalog.seriesDetail(+m[1]), "Series not found"));
route("GET", "/api/issues/:id", async (_r, m) => {
  const detail = found(await catalog.issueDetail(+m[1]), "Issue not found");
  // Opening an issue fetches its full record if we only have the list entry
  if (!detail.deep_synced) {
    const creds = await getCredentials();
    if (detail.metron_id && metronConfigured(creds)) await enqueue("metron.issue", { metron_id: detail.metron_id }, P_USER);
    else {
      // Comic Vine: credits, characters, teams, arcs (fast); GCD: stories and synopses (slower)
      if (detail.cv_id && comicvineConfigured(creds)) await enqueue("comicvine.issue_full", { issue_id: detail.id }, P_USER);
      if (detail.gcd_id) await enqueue("gcd.issue", { gcd_id: detail.gcd_id }, detail.cv_id && comicvineConfigured(creds) ? P_USER + 10 : P_USER);
    }
  }
  return detail;
});
route("GET", "/api/issues", async ({ query }) => {
  const hits = (await localSearch(query.get("q") ?? "", ["issue"], num(query.get("limit")) ?? 20)).results;
  const issues = (await db().issues.bulkGet(hits.map((h) => h.id))).filter(Boolean) as any[];
  return catalog.issueCards(issues);
});
route("GET", "/api/search", ({ query }) => localSearch(query.get("q") ?? "", query.get("kinds")?.split(",") ?? null, num(query.get("limit")) ?? 30));
route("GET", "/api/creators/:id", async (_r, m) => {
  const d = db();
  const c = found(await d.creators.get(+m[1]), "Creator not found");
  const runs = new Map<string, any>();
  for (const cr of await d.credits.where("creator_id").equals(c.id!).toArray()) {
    const i = await d.issues.get(cr.issue_id);
    if (!i) continue;
    const s = await d.series.get(i.series_id);
    const key = `${i.series_id}|${cr.role}`;
    const r = runs.get(key) ?? { series_id: i.series_id, series: s?.name ?? "", year: s?.year_began ?? null, role: cr.role, issues: 0, from: null, to: null };
    r.issues++;
    if (i.cover_date && (!r.from || i.cover_date < r.from)) r.from = i.cover_date;
    if (i.cover_date && (!r.to || i.cover_date > r.to)) r.to = i.cover_date;
    runs.set(key, r);
  }
  return { id: c.id, name: c.name, runs: [...runs.values()].sort((a, b) => (a.from ?? "9999").localeCompare(b.from ?? "9999")),
    reading_orders: (await d.readingOrders.where("creator_id").equals(c.id!).toArray()).map((o) => ({ id: o.id, name: o.name })) };
});

// ── Arcs ──
route("GET", "/api/arcs", ({ query: q }) => orders.listArcs(q.get("q"), q.get("kind"), num(q.get("publisher_id")), num(q.get("page")) ?? 1, num(q.get("size")) ?? 50));
route("GET", "/api/arcs/:id", async (_r, m) => found(await orders.arcDetail(+m[1]), "Arc not found"));
route("GET", "/api/arcs/:id/plan", async (_r, m) => found(await orders.prerequisitePlan(+m[1]), "Arc not found"));

// ── Orders and progress ──
route("GET", "/api/orders", ({ query: q }) => orders.listOrders({ kind: q.get("kind"), universe_id: num(q.get("universe_id")),
  character_id: num(q.get("character_id")), team_id: num(q.get("team_id")), arc_id: num(q.get("arc_id")), creator_id: num(q.get("creator_id")), q: q.get("q") }));
route("GET", "/api/orders/:id", async ({ query }, m) => found(await orders.orderDetail(+m[1], (query.get("path") as orders.PathName) ?? "core"), "Reading order not found"));
route("POST", "/api/orders/:id/read-through", async ({ body }, m) => {
  found(await db().readingOrders.get(+m[1]), "Reading order not found");
  return { marked: await orders.markOrderReadThrough(+m[1], Number(body.entry_id), body.path ?? "core") };
});
route("PUT", "/api/issues/:id/read", async ({ body }, m) => {
  found(await db().issues.get(+m[1]), "Issue not found");
  await orders.setRead([+m[1]], body.read !== false);
  return { issue_id: +m[1], read: body.read !== false };
});
route("PUT", "/api/arcs/:id/read", async ({ body }, m) => {
  found(await db().arcs.get(+m[1]), "Arc not found");
  const ids = (await db().arcIssues.where("arc_id").equals(+m[1]).toArray()).map((a) => a.issue_id);
  return { arc_id: +m[1], changed: await orders.setRead(ids, body.read !== false) };
});
route("PUT", "/api/series/:id/read", async ({ body }, m) => {
  found(await db().series.get(+m[1]), "Series not found");
  const ids = await db().issues.where("series_id").equals(+m[1]).primaryKeys();
  return { series_id: +m[1], changed: await orders.setRead(ids, body.read !== false) };
});
route("GET", "/api/progress", () => orders.progressSummary());

// ── Characters and teams ──
route("GET", "/api/characters", ({ query: q }) => chars.listCharacters(q.get("q"), num(q.get("publisher_id")), num(q.get("page")) ?? 1, num(q.get("size")) ?? 60));
route("GET", "/api/characters/:id", async (_r, m) => found(await chars.characterDetail(+m[1]), "Character not found"));
route("GET", "/api/characters/:id/appearances", ({ query: q }, m) => chars.appearances(+m[1], { identity_id: num(q.get("identity_id")),
  role: q.get("role"), universe_id: num(q.get("universe_id")), era_id: num(q.get("era_id")), page: num(q.get("page")) ?? 1, size: num(q.get("size")) ?? 60 }));
route("GET", "/api/characters/:id/graph", (_r, m) => sharedTeamHistory(+m[1]));
route("GET", "/api/teams", ({ query: q }) => chars.listTeams(q.get("q"), num(q.get("page")) ?? 1, num(q.get("size")) ?? 60));
route("GET", "/api/teams/:id", async (_r, m) => found(await chars.teamDetail(+m[1]), "Team not found"));
route("GET", "/api/teams/:id/issues", ({ query: q }, m) => chars.teamIssues(+m[1], num(q.get("page")) ?? 1, num(q.get("size")) ?? 60));

// ── Library ──
const libFile = async (id: number) => found(await db().libraryFiles.get(id), "File not found");
route("GET", "/api/library", ({ query: q }) => listLibrary({ q: q.get("q"), status: q.get("status") ?? "all", sort: q.get("sort") ?? "added",
  page: num(q.get("page")) ?? 1, size: num(q.get("size")) ?? 60 }));
route("POST", "/api/library/upload", async ({ body }) => {
  const files: File[] = body instanceof FormData ? (body.getAll("files") as File[]) : [];
  const results = [];
  for (const f of files) {
    try {
      const [lf, created] = await importComic(new Uint8Array(await f.arrayBuffer()), f.name);
      results.push({ name: f.name, ok: true, created, file: await fileCard(lf) });
    } catch (e) {
      results.push({ name: f.name, ok: false, error: e instanceof ImportError ? e.message : (e as Error).message });
    }
  }
  return { results };
});
route("GET", "/api/library/:id", async (_r, m) => fileCard(await libFile(+m[1])));
route("PATCH", "/api/library/:id", async ({ body }, m) => {
  const d = db();
  const f = await libFile(+m[1]);
  if (body.issue_id != null) {
    found(await d.issues.get(Number(body.issue_id)), "Issue not found");
    await d.libraryFiles.update(f.id!, { issue_id: Number(body.issue_id), match_method: "manual", match_confidence: 1 });
  } else {
    await d.libraryFiles.update(f.id!, { match_method: null });
    await applyMatch((await d.libraryFiles.get(f.id!))!);
  }
  return fileCard((await d.libraryFiles.get(f.id!))!);
});
route("POST", "/api/library/:id/rematch", async (_r, m) => {
  const d = db();
  const f = await libFile(+m[1]);
  if (f.match_method === "manual") await d.libraryFiles.update(f.id!, { match_method: null });
  await applyMatch((await d.libraryFiles.get(f.id!))!);
  return fileCard((await d.libraryFiles.get(f.id!))!);
});
route("DELETE", "/api/library/:id", async (_r, m) => { await removeFile(await libFile(+m[1])); return { deleted: +m[1] }; });
route("GET", "/api/library/:id/pages/:n/panels", async ({ query }, m) => {
  const f = await libFile(+m[1]);
  if (+m[2] >= f.page_count) throw new HttpError(404, "Page out of range");
  return pagePanels(f, +m[2], bool(query.get("rtl")));
});
route("PUT", "/api/library/:id/position", async ({ body }, m) => recordPosition(await libFile(+m[1]), Number(body.page)));

// ── OPDS ──
const feedCard = (f: { id?: Id; name: string; url: string; username?: string | null; password?: string | null }, builtin = false) =>
  ({ id: f.id, name: f.name, url: f.url, username: f.username ?? null, has_password: !!f.password, builtin });
/** A built-in feed has no database row, so it is resolved from the shipped list first. */
const opdsFeed = async (id: number) => builtinFeed(id) ?? found(await db().opdsFeeds.get(id), "Feed not found");
route("GET", "/api/opds", async () => [
  ...builtinFeeds().map((f) => feedCard(f, true)),
  ...(await db().opdsFeeds.toArray()).map((f) => feedCard(f)),
]);
route("POST", "/api/opds", async ({ body }) => {
  try { await browseOpds(body.url, body.username, body.password); } catch (e) { throw new HttpError(400, `Could not read that OPDS feed: ${(e as Error).message}`); }
  const id = await db().opdsFeeds.add({ name: body.name, url: body.url, username: body.username || null, password: body.password || null, created_at: nowIso() });
  return { id, name: body.name, url: body.url, username: body.username || null, has_password: !!body.password };
});
route("DELETE", "/api/opds/:id", async (_r, m) => {
  if (builtinFeed(+m[1])) throw new HttpError(400, "That feed is built in and cannot be removed");
  await db().opdsFeeds.delete(+m[1]);
  return { deleted: +m[1] };
});
route("GET", "/api/opds/:id/browse", async ({ query }, m) => {
  const feed = await opdsFeed(+m[1]);
  const target = query.get("url") || feed.url;
  const sameOrigin = new URL(target).origin === new URL(feed.url).origin;
  try { return await browseOpds(target, sameOrigin ? feed.username : null, sameOrigin ? feed.password : null); } catch (e) { throw new HttpError(502, `OPDS feed error: ${(e as Error).message}`); }
});
route("POST", "/api/opds/:id/import", async ({ body }, m) => {
  const feed = await opdsFeed(+m[1]);
  try {
    const [lf, created] = await importFromOpds(feed, body.href, body.title);
    return { created, file: await fileCard(lf) };
  } catch (e) {
    throw new HttpError(e instanceof ImportError ? 422 : 502, (e as Error).message);
  }
});
void parseOpdsFeed;

// ── Admin: sync and jobs ──
route("GET", "/api/admin/metron/search", async ({ query }) => {
  const kind = query.get("kind") ?? "series";
  const results = await metronSync.search(await getMetron(), kind, query.get("q") ?? "", num(query.get("year"))) as any[];
  const d = db();
  const ids = results.map((r) => r.metron_id);
  const have = new Set(kind === "series" ? (await d.series.where("metron_id").anyOf(ids).toArray()).map((x) => x.metron_id)
    : kind === "arc" ? (await d.arcs.where("metron_id").anyOf(ids).toArray()).map((x) => x.metron_id)
      : kind === "character" ? (await d.identities.where("metron_id").anyOf(ids).toArray()).map((x) => x.metron_id)
        : kind === "team" ? (await d.teams.where("metron_id").anyOf(ids).toArray()).map((x) => x.metron_id)
          : (await d.readingOrders.where("metron_reading_list_id").anyOf(ids).toArray()).map((x) => x.metron_reading_list_id));
  return results.map((r) => ({ ...r, in_catalog: have.has(r.metron_id) }));
});
route("GET", "/api/admin/gcd/search", async ({ query }) => {
  const rows = await gcdSync.searchGcd((await getGcd()), query.get("q") ?? "", num(query.get("year")));
  const have = new Set((await db().series.where("gcd_id").anyOf(rows.map((r) => r.gcd_id as number)).toArray()).map((s) => s.gcd_id));
  return rows.map((r) => ({ ...r, in_catalog: have.has(r.gcd_id as number) }));
});
route("POST", "/api/admin/sync", async ({ body }) => {
  const k = String(body.kind);
  const map: Record<string, [string, Record<string, unknown>]> = {
    publishers: ["metron.publishers", {}],
    series: ["metron.series", { metron_id: body.metron_id, deep: body.deep !== false }],
    issue: ["metron.issue", { metron_id: body.metron_id }],
    arc: ["metron.arc", { metron_id: body.metron_id, deep: body.deep !== false }],
    character: ["metron.character", { metron_id: body.metron_id, with_issues: body.with_issues !== false }],
    team: ["metron.team", { metron_id: body.metron_id, with_issues: body.with_issues !== false }],
    reading_list: ["metron.reading_list", { metron_id: body.metron_id }],
    find_series: ["metron.find_series", { name: body.name, year: body.year ?? null, deep: body.deep !== false }],
    gcd_series: ["gcd.series", { gcd_id: body.gcd_id, deep: body.deep !== false }],
    gcd_issue: ["gcd.issue", { gcd_id: body.gcd_id }],
    comicvine_identity: ["comicvine.identity", { identity_id: body.id }],
    comicvine_team: ["comicvine.team", { team_id: body.id }],
    comicvine_arc: ["comicvine.arc", { arc_id: body.id }],
    comicvine_issue: ["comicvine.issue", { issue_id: body.id }],
    derive_team: ["teams.derive", { team_id: body.id }],
  };
  const entry = map[k];
  if (!entry) throw new HttpError(422, `Unknown sync kind ${k}`);
  if (Object.values(entry[1]).some((v) => v === undefined)) throw new HttpError(422, "Missing id/name for this sync kind");
  return jobCard(await enqueue(entry[0], entry[1], P_USER));
});
const jobCard = (j: any) => ({ ...j, priority: j.priority, payload: j.payload });
route("GET", "/api/admin/jobs", async ({ query }) => {
  const all = (await db().jobs.toArray()).sort((a, b) => b.id! - a.id!);
  const status = query.get("status");
  const counts: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const j of all) counts[j.status]++;
  return { counts, jobs: all.filter((j) => !status || j.status === status).slice(0, num(query.get("limit")) ?? 100).map(jobCard) };
});
route("POST", "/api/admin/jobs/:id/retry", async (_r, m) => {
  const d = db();
  found(await d.jobs.get(+m[1]), "Job not found");
  await d.jobs.update(+m[1], { status: "queued", error: null, run_after: null });
  await enqueue("library.rematch", {}, P_DERIVE); // nudges the worker
  return jobCard(await d.jobs.get(+m[1]));
});
route("DELETE", "/api/admin/jobs", async ({ query }) => {
  const status = query.get("status") ?? "done";
  const ids = (await db().jobs.where("status").equals(status).toArray()).map((j) => j.id!);
  await db().jobs.bulkDelete(ids);
  return { deleted: ids.length };
});
route("POST", "/api/admin/starter-pack", () => applyStarterPack());
route("GET", "/api/admin/snapshot", () => exportSnapshot());
route("POST", "/api/admin/snapshot", async ({ body }) => {
  try { return { written: await importSnapshot(body) }; }
  catch (e) { throw new HttpError(e instanceof SnapshotError ? 409 : 400, (e as Error).message); }
});
route("GET", "/api/admin/starter-pack/arcs", async () => starterArcNames());

// ── Admin: reading orders ──
const touch = async (orderId: Id) => {
  const o = await db().readingOrders.get(orderId);
  if (o) await db().readingOrders.update(orderId, { source: o.source === "generated" ? "curated" : o.source, updated_at: nowIso() });
};
async function renumber(orderId: Id) {
  const entries = await orders.orderEntries(orderId);
  await db().entries.bulkPut(entries.map((e, i) => ({ ...e, position: i })));
}
route("POST", "/api/admin/orders", async ({ body }) => {
  const d = db();
  let slug = slugify(body.name) || "order", n = 2;
  while (await d.readingOrders.where("slug").equals(slug).first()) slug = `${slugify(body.name)}-${n++}`;
  const id = await d.readingOrders.add({ name: body.name, slug, kind: body.kind ?? "custom", description: body.description ?? null,
    universe_id: body.universe_id ?? null, era_id: body.era_id ?? null, character_id: body.character_id ?? null, team_id: body.team_id ?? null,
    arc_id: body.arc_id ?? null, creator_id: body.creator_id ?? null, source: "curated", created_at: nowIso(), updated_at: nowIso(),
    words: words(body.name, body.description) });
  return orders.orderCard((await d.readingOrders.get(id))!);
});
route("PATCH", "/api/admin/orders/:id", async ({ body }, m) => {
  const d = db();
  const o = found(await d.readingOrders.get(+m[1]), "Reading order not found");
  const patch: any = {};
  for (const k of ["name", "kind", "description"]) if (k in body) patch[k] = body[k];
  const next = { ...o, ...patch };
  await d.readingOrders.update(o.id!, { ...patch, words: words(next.name, next.description) });
  await touch(o.id!);
  return orders.orderCard((await d.readingOrders.get(o.id!))!);
});
route("DELETE", "/api/admin/orders/:id", async (_r, m) => {
  const d = db();
  found(await d.readingOrders.get(+m[1]), "Reading order not found");
  const entryIds = await d.entries.where("order_id").equals(+m[1]).primaryKeys();
  if (entryIds.length) await d.entryPrereqs.where("entry_id").anyOf(entryIds).delete();
  await d.entries.bulkDelete(entryIds);
  await d.readingOrders.delete(+m[1]);
  return { deleted: +m[1] };
});
route("POST", "/api/admin/orders/:id/entries", async ({ body }, m) => {
  const d = db();
  const orderId = +m[1];
  found(await d.readingOrders.get(orderId), "Reading order not found");
  if ((body.issue_id == null) === (body.arc_id == null)) throw new HttpError(422, "Give exactly one of issue_id or arc_id");
  if (body.issue_id != null) found(await d.issues.get(Number(body.issue_id)), "Issue not found");
  else found(await d.arcs.get(Number(body.arc_id)), "Arc not found");
  const entries = await orders.orderEntries(orderId);
  const pos = body.position == null ? entries.length : Math.max(0, Math.min(Number(body.position), entries.length));
  await d.entries.bulkPut(entries.filter((e) => e.position >= pos).map((e) => ({ ...e, position: e.position + 1 })));
  const id = await d.entries.add({ order_id: orderId, position: pos, issue_id: body.issue_id ?? null, arc_id: body.arc_id ?? null,
    tier: (body.tier ?? "recommended") as Tier, note: body.note ?? null });
  await renumber(orderId);
  await touch(orderId);
  return { id, position: (await d.entries.get(id))!.position };
});
route("PATCH", "/api/admin/entries/:id", async ({ body }, m) => {
  const d = db();
  const entry = found(await d.entries.get(+m[1]), "Entry not found");
  if ("position" in body) {
    const others = (await orders.orderEntries(entry.order_id)).filter((e) => e.id !== entry.id);
    others.splice(Math.max(0, Math.min(Number(body.position), others.length)), 0, entry);
    await d.entries.bulkPut(others.map((e, i) => ({ ...e, position: i })));
  }
  const patch: any = {};
  for (const k of ["tier", "note"]) if (k in body) patch[k] = body[k];
  if (Object.keys(patch).length) await d.entries.update(entry.id!, patch);
  await touch(entry.order_id);
  const fresh = (await d.entries.get(entry.id!))!;
  return { id: fresh.id, position: fresh.position, tier: fresh.tier, note: fresh.note ?? null };
});
route("DELETE", "/api/admin/entries/:id", async (_r, m) => {
  const d = db();
  const entry = found(await d.entries.get(+m[1]), "Entry not found");
  await d.entryPrereqs.where("entry_id").equals(entry.id!).delete();
  await d.entries.delete(entry.id!);
  await renumber(entry.order_id);
  await touch(entry.order_id);
  return { deleted: +m[1] };
});
route("POST", "/api/admin/orders/:id/reorder", async ({ body }, m) => {
  const entries = await orders.orderEntries(+m[1]);
  const ids: number[] = body.entry_ids ?? [];
  if (ids.length !== entries.length || !entries.every((e) => ids.includes(e.id!))) throw new HttpError(422, "entry_ids must list every entry of the order exactly once");
  await db().entries.bulkPut(ids.map((id, position) => ({ ...entries.find((e) => e.id === id)!, position })));
  await touch(+m[1]);
  return { order_id: +m[1], entries: ids.length };
});
route("POST", "/api/admin/orders/:id/tiers", async ({ body }, m) => {
  const entries = (await orders.orderEntries(+m[1])).filter((e) => (body.entry_ids ?? []).includes(e.id));
  await db().entries.bulkPut(entries.map((e) => ({ ...e, tier: body.tier })));
  await touch(+m[1]);
  return { updated: entries.length };
});
route("POST", "/api/admin/entries/:id/prerequisites", async ({ body }, m) => {
  const entry = found(await db().entries.get(+m[1]), "Entry not found");
  if ((body.requires_arc_id == null) === (body.requires_issue_id == null)) throw new HttpError(422, "Give exactly one of requires_arc_id or requires_issue_id");
  const id = await db().entryPrereqs.add({ entry_id: entry.id!, requires_arc_id: body.requires_arc_id ?? null, requires_issue_id: body.requires_issue_id ?? null, note: body.note ?? null });
  await touch(entry.order_id);
  return { id };
});
route("DELETE", "/api/admin/prerequisites/:id", async (_r, m) => { await db().entryPrereqs.delete(+m[1]); return { deleted: +m[1] }; });
route("POST", "/api/admin/orders/generate", async ({ body }) => {
  const d = db();
  const id = Number(body.id);
  const source = String(body.source);
  const table = { event: d.arcs, character: d.characters, team: d.teams, writer: d.creators, universe: d.universes }[source];
  if (!table) throw new HttpError(422, "Unknown source");
  found(await (table as any).get(id), `${source} not found`);
  const replace = body.replace !== false;
  const order = source === "event" ? await orders.generateEventOrder(id, replace)
    : source === "character" ? await orders.generateCharacterOrder(id, replace)
      : source === "team" ? await orders.generateTeamOrder(id, replace)
        : source === "writer" ? await orders.generateWriterOrder(id, body.series_id ?? null, replace)
          : await orders.generateUniverseOrder(id, body.era_id ?? null, replace);
  return orders.orderCard((await d.readingOrders.get(order.id!))!);
});

// ── Admin: arcs ──
route("POST", "/api/admin/arcs", async ({ body }) => {
  const d = db();
  const id = await d.arcs.add({ name: body.name, kind: body.kind ?? "arc", description: body.description ?? null, publisher_id: body.publisher_id ?? null, words: words(body.name) });
  for (const [pos, iid] of (body.issue_ids ?? []).entries()) await d.arcIssues.put({ arc_id: id, issue_id: iid, position: pos, role: "core" });
  return orders.arcSummary((await d.arcs.get(id))!);
});
route("PATCH", "/api/admin/arcs/:id", async ({ body }, m) => {
  const d = db();
  const arc = found(await d.arcs.get(+m[1]), "Arc not found");
  const patch: any = {};
  for (const k of ["name", "kind", "description"]) if (k in body) patch[k] = body[k];
  await d.arcs.update(arc.id!, { ...patch, words: words((patch.name as string) ?? arc.name) });
  return orders.arcSummary((await d.arcs.get(arc.id!))!);
});
route("POST", "/api/admin/arcs/:id/issues", async ({ body }, m) => {
  const d = db();
  found(await d.arcs.get(+m[1]), "Arc not found");
  found(await d.issues.get(Number(body.issue_id)), "Issue not found");
  const existing = await d.arcIssues.get([+m[1], Number(body.issue_id)]);
  const last = Math.max(-1, ...(await d.arcIssues.where("arc_id").equals(+m[1]).toArray()).map((a) => a.position));
  const row = { arc_id: +m[1], issue_id: Number(body.issue_id), position: body.position ?? existing?.position ?? last + 1,
    role: body.role ?? "core", tier: body.tier ?? null };
  await d.arcIssues.put(row);
  return { arc_id: row.arc_id, issue_id: row.issue_id, role: row.role, tier: row.tier };
});
route("DELETE", "/api/admin/arcs/:id/issues/:issue", async (_r, m) => {
  found(await db().arcIssues.get([+m[1], +m[2]]), "Issue is not in this arc");
  await db().arcIssues.delete([+m[1], +m[2]]);
  return { deleted: [+m[1], +m[2]] };
});
route("POST", "/api/admin/arcs/:id/links", async ({ body }, m) => {
  const d = db();
  const arcId = +m[1], target = Number(body.target_arc_id);
  found(await d.arcs.get(arcId), "Arc not found");
  found(await d.arcs.get(target), "Target arc not found");
  if (body.kind === "prerequisite" && await orders.wouldCreateCycle(arcId, target)) throw new HttpError(409, "That would make the prerequisites circular");
  const existing = await d.arcLinks.where("[arc_id+target_arc_id+kind]").equals([arcId, target, body.kind]).first();
  if (existing) { await d.arcLinks.update(existing.id!, { note: body.note ?? null }); return { id: existing.id }; }
  return { id: await d.arcLinks.add({ arc_id: arcId, target_arc_id: target, kind: body.kind, note: body.note ?? null, source: "curated" }) };
});
route("DELETE", "/api/admin/arc-links/:id", async (_r, m) => { await db().arcLinks.delete(+m[1]); return { deleted: +m[1] }; });

// ── Admin: characters, teams, taxonomy ──
route("POST", "/api/admin/characters", async ({ body }) => {
  const id = await db().characters.add({ name: body.name, description: body.description ?? null, image_url: body.image_url ?? null,
    publisher_id: body.publisher_id ?? null, words: words(body.name) });
  return { id, name: body.name };
});
route("PATCH", "/api/admin/characters/:id", async ({ body }, m) => {
  const d = db();
  const c = found(await d.characters.get(+m[1]), "Character not found");
  const patch: any = {};
  for (const k of ["name", "description", "image_url"]) if (k in body) patch[k] = body[k];
  await d.characters.update(c.id!, { ...patch, words: words((patch.name as string) ?? c.name) });
  return { id: c.id, name: (patch.name as string) ?? c.name };
});
route("PATCH", "/api/admin/identities/:id", async ({ body }, m) => {
  const d = db();
  const ident = found(await d.identities.get(+m[1]), "Identity not found");
  const oldCharacter = ident.character_id;
  const patch: any = {};
  if (body.character_id != null) { found(await d.characters.get(Number(body.character_id)), "Character not found"); patch.character_id = Number(body.character_id); }
  if (body.display_name) patch.display_name = body.display_name;
  await d.identities.update(ident.id!, patch);
  const fresh = (await d.identities.get(ident.id!))!;
  // A mantle left with no identities is removed (its reading orders move to the new mantle)
  if (oldCharacter !== fresh.character_id && !(await d.identities.where("character_id").equals(oldCharacter).count())) {
    for (const o of await d.readingOrders.where("character_id").equals(oldCharacter).toArray()) await d.readingOrders.update(o.id!, { character_id: fresh.character_id });
    await d.characters.delete(oldCharacter);
  }
  return { id: fresh.id, character_id: fresh.character_id, display_name: fresh.display_name };
});
route("POST", "/api/admin/character-events", async ({ body }) => {
  const d = db();
  const ident = found(await d.identities.get(Number(body.identity_id)), "Identity not found");
  const id = await d.characterEvents.add({ identity_id: ident.id!, kind: body.kind, issue_id: body.issue_id ?? null, issue_text: body.issue_text ?? null,
    end_issue_id: body.end_issue_id ?? null, note: body.note ?? null, image_url: body.image_url ?? null, source: "curated" });
  if (body.kind === "first_appearance" && body.issue_id) await d.identities.update(ident.id!, { first_appearance_issue_id: body.issue_id });
  return { id };
});
route("DELETE", "/api/admin/character-events/:id", async (_r, m) => { await db().characterEvents.delete(+m[1]); return { deleted: +m[1] }; });
route("PUT", "/api/admin/appearances", async ({ body }) => {
  const d = db();
  found(await d.issues.get(Number(body.issue_id)), "Issue not found");
  found(await d.identities.get(Number(body.identity_id)), "Identity not found");
  await d.appearances.put({ issue_id: Number(body.issue_id), identity_id: Number(body.identity_id), role: body.role, role_source: "curated" });
  return { issue_id: body.issue_id, identity_id: body.identity_id, role: body.role };
});
route("POST", "/api/admin/memberships", async ({ body }) => {
  found(await db().teams.get(Number(body.team_id)), "Team not found");
  found(await db().identities.get(Number(body.identity_id)), "Identity not found");
  return { id: await db().memberships.add({ team_id: Number(body.team_id), identity_id: Number(body.identity_id), from_issue_id: body.from_issue_id ?? null,
    to_issue_id: body.to_issue_id ?? null, note: body.note ?? null, source: "curated" }) };
});
route("PATCH", "/api/admin/memberships/:id", async ({ body }, m) => {
  found(await db().memberships.get(+m[1]), "Membership not found");
  const patch: any = { source: "curated" };
  for (const k of ["from_issue_id", "to_issue_id", "note"]) if (k in body) patch[k] = body[k];
  await db().memberships.update(+m[1], patch);
  return { id: +m[1] };
});
route("DELETE", "/api/admin/memberships/:id", async (_r, m) => { await db().memberships.delete(+m[1]); return { deleted: +m[1] }; });
route("POST", "/api/admin/teams/:id/derive", async (_r, m) => { found(await db().teams.get(+m[1]), "Team not found"); return deriveMemberships(+m[1]); });
route("POST", "/api/admin/team-links", async ({ body }) => {
  if (Number(body.team_id) === Number(body.other_team_id)) throw new HttpError(422, "A team can't link to itself");
  found(await db().teams.get(Number(body.team_id)), "Team not found");
  found(await db().teams.get(Number(body.other_team_id)), "Team not found");
  return { id: await db().teamLinks.add({ team_id: Number(body.team_id), other_team_id: Number(body.other_team_id), kind: body.kind ?? "related", note: body.note ?? null, source: "curated" }) };
});
route("DELETE", "/api/admin/team-links/:id", async (_r, m) => { await db().teamLinks.delete(+m[1]); return { deleted: +m[1] }; });
route("POST", "/api/admin/universes", async ({ body }) => {
  const d = db();
  const slug = slugify(body.name);
  if (await d.universes.where("slug").equals(slug).first()) throw new HttpError(409, "A universe with that name exists");
  const id = await d.universes.add({ name: body.name, slug, kind: body.kind ?? "alternate", designation: body.designation ?? null,
    description: body.description ?? null, publisher_id: body.publisher_id ?? null, sort_order: 300 });
  await d.eras.add({ universe_id: id, name: "All years", slug: "all-years", start_date: "1900-01-01" });
  return { id, slug };
});
route("PATCH", "/api/admin/universes/:id", async ({ body }, m) => {
  found(await db().universes.get(+m[1]), "Universe not found");
  const patch: any = {};
  for (const k of ["name", "kind", "designation", "description"]) if (k in body) patch[k] = body[k];
  await db().universes.update(+m[1], patch);
  return { id: +m[1] };
});
route("POST", "/api/admin/eras", async ({ body }) => {
  found(await db().universes.get(Number(body.universe_id)), "Universe not found");
  return { id: await db().eras.add({ universe_id: Number(body.universe_id), name: body.name, slug: slugify(body.name), start_date: body.start_date,
    end_date: body.end_date ?? null, description: body.description ?? null }) };
});
route("PATCH", "/api/admin/eras/:id", async ({ body }, m) => {
  found(await db().eras.get(+m[1]), "Era not found");
  const patch: any = {};
  for (const k of ["name", "start_date", "end_date", "description"]) if (k in body) patch[k] = body[k];
  if (body.name) patch.slug = slugify(body.name);
  await db().eras.update(+m[1], patch);
  return { id: +m[1] };
});
route("DELETE", "/api/admin/eras/:id", async (_r, m) => { await db().eras.delete(+m[1]); return { deleted: +m[1] }; });
route("PUT", "/api/admin/series/:id/universes", async ({ body }, m) => {
  const d = db();
  found(await d.series.get(+m[1]), "Series not found");
  await d.seriesUniverses.where("series_id").equals(+m[1]).delete();
  for (const uid of [...new Set<number>(body.universe_ids ?? [])]) {
    found(await d.universes.get(uid), `Universe ${uid} not found`);
    await d.seriesUniverses.put({ series_id: +m[1], universe_id: uid, source: "curated" });
  }
  return { series_id: +m[1], universe_ids: body.universe_ids ?? [] };
});

/** Dispatches one request. Throws HttpError with the status the server would return. */
export async function handle(method: string, pathWithQuery: string, body?: unknown): Promise<unknown> {
  const url = new URL(pathWithQuery, "http://device");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  for (const [m, re, fn] of routes) {
    if (m !== method) continue;
    const match = path.match(re);
    if (!match) continue;
    try {
      return await fn({ method, path, query: url.searchParams, body: body ?? {} }, match);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof NotConfiguredError) throw new HttpError(400, e.message);
      if (e instanceof AuthError) throw new HttpError(401, e.message);
      if (e instanceof RateLimitError) throw new HttpError(429, e.message);
      if (e instanceof NotFoundError) throw new HttpError(404, e.message);
      throw new HttpError(500, (e as Error).message || "Something went wrong");
    }
  }
  throw new HttpError(404, `No route for ${method} ${path}`);
}

export { onJobFinished };
