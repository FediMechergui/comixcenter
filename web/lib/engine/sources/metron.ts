/**
 * Metron (metron.cloud) client, a TypeScript stand-in for mokkari's `Session`.
 *
 * Objects come back with mokkari's *Python attribute names* (aliases resolved), so the port of
 * backend/comix/ingest/metron_sync.py can read them line by line:
 *   issue list items: raw `issue` → `issue_name`; series lists: raw `series` → `display_name`;
 *   issue detail: raw `title` → `collection_title`, `name` → `story_titles`, `page` → `page_count`;
 *   associated series: raw `series` → `name`.
 * Dates stay "YYYY-MM-DD" strings, datetimes ISO strings, decimals numbers, URLs strings.
 *
 * Differences from mokkari, on purpose:
 * - Detail methods return `null` on 404 (mokkari raises ApiError) — the sync code already treats
 *   `None` as "not found", and the backend's fake Metron returns None the same way.
 *   List endpoints still throw NotFoundError on 404 (e.g. issue_list of a missing series).
 * - Instead of failing fast when headers show the burst window is empty, requests wait (≤ 65s);
 *   only the daily ("sustained") limit and long 429s raise RateLimitError.
 */
import { AuthError, NotFoundError, RateLimitError, SourceError } from "../contracts";
import type { HttpFn, ResponseCache } from "../contracts";
import { cachedGet, cacheKey, base64Utf8, formatSeconds, isRecord, Pacer, pacedRequest, USER_AGENT } from "./http";
import type { Clock, SourceTestResult } from "./http";

export const METRON_API = "https://metron.cloud/api/";

/** Metron guarantees ≥ 20 requests/min per user, so 3s spacing never trips the burst limit. */
export const METRON_MIN_INTERVAL_MS = 3_000;

export type MetronAuth = { token: string } | { username: string; password: string };

export interface MetronClientOptions {
  http: HttpFn;
  auth: MetronAuth;
  cache?: ResponseCache;
  /** Share one pacer between every Metron client of the app */
  pacer?: Pacer;
  /** Seconds a cached response stays valid (default 1 day; 0 disables caching) */
  cacheTtlSeconds?: number;
  /** Only used when no pacer is passed */
  clock?: Clock;
  baseUrl?: string;
}

export type MetronParams = Record<string, string | number | boolean | undefined>;

// ── Returned shapes (mokkari attribute names) ────────────────────────────────

/** mokkari GenericItem */
export interface MetronGenericItem { id: number; name: string }
/** mokkari BaseResource (list rows and nested refs) */
export interface MetronResource { id: number; name: string; modified: string | null }

export interface MetronPublisher extends MetronResource {
  alt_names: string[]; founded: number | null; country: string; desc: string; image: string | null;
  cv_id: number | null; gcd_id: number | null; resource_url: string;
}

export interface MetronUniverse extends MetronResource {
  publisher: MetronGenericItem | null; designation: string; desc: string; image: string | null;
  gcd_id: number | null; resource_url: string;
}

export interface MetronAssociatedSeries { id: number; name: string }

export interface MetronSeries {
  id: number; name: string; sort_name: string; volume: number; year_began: number; year_end: number | null;
  issue_count: number; modified: string | null; alt_names: string[]; language: string;
  series_type: MetronGenericItem | null; status: string; publisher: MetronGenericItem | null;
  imprint: MetronGenericItem | null; desc: string; genres: MetronGenericItem[];
  associated: MetronAssociatedSeries[]; cv_id: number | null; gcd_id: number | null; resource_url: string;
}

/** mokkari BaseSeries (series_list rows) */
export interface MetronSeriesListItem {
  id: number; display_name: string; year_began: number; year_end: number | null; issue_count: number;
  volume: number; modified: string | null; publisher: MetronGenericItem | null;
  series_type: MetronGenericItem | null; cv_id: number | null; gcd_id: number | null;
}

/** mokkari BasicSeries (the series ref inside issue list rows) */
export interface MetronBasicSeries { id: number; name: string; volume: number; year_began: number }

/** mokkari BaseIssue (issue list rows) */
export interface MetronIssueListItem {
  id: number; number: string; cover_date: string | null; store_date: string | null; foc_date: string | null;
  image: string | null; cover_hash: string; modified: string | null; issue_name: string;
  series: MetronBasicSeries;
  /** Not in mokkari's BaseIssue (the sync reads it with getattr); passed through when Metron sends it */
  cv_id?: number | null;
  gcd_id?: number | null;
}

export interface MetronIssueSeries {
  id: number; name: string; sort_name: string; alt_names: string[]; volume: number; year_began: number;
  series_type: MetronGenericItem | null; genres: MetronGenericItem[]; language: string;
}

export interface MetronCredit { id: number; creator: string; role: MetronGenericItem[] }
export interface MetronReprint { id: number; issue: string }
export interface MetronVariant { name: string; price: number | null; sku: string; upc: string; image: string | null }

export interface MetronIssue {
  id: number; number: string; cover_date: string | null; store_date: string | null; foc_date: string | null;
  image: string | null; cover_hash: string; modified: string | null;
  publisher: MetronGenericItem | null; imprint: MetronGenericItem | null; series: MetronIssueSeries;
  alt_number: string; collection_title: string; story_titles: string[]; price: number | null;
  price_currency: string; rating: MetronGenericItem | null; sku: string; isbn: string; upc: string;
  page_count: number | null; desc: string; arcs: MetronResource[]; credits: MetronCredit[];
  characters: MetronResource[]; teams: MetronResource[]; universes: MetronResource[];
  reprints: MetronReprint[]; variants: MetronVariant[]; average_rating: number | null; rating_count: number;
  cv_id: number | null; gcd_id: number | null; resource_url: string;
}

export interface MetronArc extends MetronResource {
  desc: string; image: string | null; cv_id: number | null; gcd_id: number | null; resource_url: string;
}

export interface MetronCharacter extends MetronResource {
  alias: string[] | null; desc: string; image: string | null; creators: MetronResource[];
  teams: MetronResource[]; universes: MetronResource[]; cv_id: number | null; gcd_id: number | null;
  resource_url: string;
}

export interface MetronTeam extends MetronResource {
  desc: string; image: string | null; creators: MetronResource[]; universes: MetronResource[];
  cv_id: number | null; gcd_id: number | null; resource_url: string;
}

export interface MetronUser { id: number; username: string }
export interface MetronReadingListNav { id: number; name: string }

export interface MetronReadingList {
  id: number; user: MetronUser | null; name: string; slug: string; desc: string; image: string | null;
  list_type: string; is_private: boolean; attribution_source: string | null; attribution_url: string | null;
  previous: MetronReadingListNav | null; next: MetronReadingListNav | null; average_rating: number | null;
  rating_count: number; items_url: string; resource_url: string; modified: string | null;
}

export interface MetronReadingListListItem {
  id: number; name: string; slug: string; user: MetronUser | null; list_type: string; is_private: boolean;
  attribution_source: string | null; average_rating: number | null; rating_count: number; modified: string | null;
}

export interface MetronReadingListIssue {
  id: number; series: MetronBasicSeries; number: string; cover_date: string | null; store_date: string | null;
  cv_id: number | null; gcd_id: number | null; modified: string | null;
}

export interface MetronReadingListItem {
  id: number; issue: MetronReadingListIssue; order: number | null; issue_type: string;
}

/** Last rate-limit state Metron reported (X-RateLimit-* headers); reset times in epoch ms. */
export interface MetronRateLimitStatus {
  burst: { limit: number | null; remaining: number | null; reset: number | null };
  sustained: { limit: number | null; remaining: number | null; reset: number | null };
}

// ── Raw JSON → mokkari attributes ────────────────────────────────────────────

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v == null || str(v) === "" ? null : str(v));
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown, fallback = 0): number => num(v) ?? fallback;
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

const generic = (v: unknown): MetronGenericItem | null =>
  isRecord(v) ? { id: int(v.id), name: str(v.name) } : null;
const resource = (v: Raw): MetronResource => ({ id: int(v.id), name: str(v.name), modified: strOrNull(v.modified) });
const resources = (v: unknown): MetronResource[] => arr(v).map(resource);

function basicSeries(v: unknown): MetronBasicSeries {
  const r = isRecord(v) ? v : {};
  return { id: int(r.id), name: str(r.name), volume: int(r.volume, 1), year_began: int(r.year_began) };
}

export function mapPublisher(r: Raw): MetronPublisher {
  return { ...resource(r), alt_names: strings(r.alt_names), founded: num(r.founded), country: str(r.country),
           desc: str(r.desc), image: strOrNull(r.image), cv_id: num(r.cv_id), gcd_id: num(r.gcd_id),
           resource_url: str(r.resource_url) };
}

export function mapUniverse(r: Raw): MetronUniverse {
  return { ...resource(r), publisher: generic(r.publisher), designation: str(r.designation), desc: str(r.desc),
           image: strOrNull(r.image), gcd_id: num(r.gcd_id), resource_url: str(r.resource_url) };
}

export function mapSeries(r: Raw): MetronSeries {
  return {
    id: int(r.id), name: str(r.name), sort_name: str(r.sort_name), volume: int(r.volume, 1),
    year_began: int(r.year_began), year_end: num(r.year_end), issue_count: int(r.issue_count),
    modified: strOrNull(r.modified), alt_names: strings(r.alt_names), language: str(r.language),
    series_type: generic(r.series_type), status: str(r.status), publisher: generic(r.publisher),
    imprint: generic(r.imprint), desc: str(r.desc), genres: arr(r.genres).map((g) => generic(g)!),
    associated: arr(r.associated).map((a) => ({ id: int(a.id), name: str(a.series) })),
    cv_id: num(r.cv_id), gcd_id: num(r.gcd_id), resource_url: str(r.resource_url),
  };
}

export function mapSeriesListItem(r: Raw): MetronSeriesListItem {
  return {
    id: int(r.id), display_name: str(r.series), year_began: int(r.year_began), year_end: num(r.year_end),
    issue_count: int(r.issue_count), volume: int(r.volume, 1), modified: strOrNull(r.modified),
    publisher: generic(r.publisher), series_type: generic(r.series_type), cv_id: num(r.cv_id), gcd_id: num(r.gcd_id),
  };
}

export function mapIssueListItem(r: Raw): MetronIssueListItem {
  const out: MetronIssueListItem = {
    id: int(r.id), number: str(r.number), cover_date: strOrNull(r.cover_date), store_date: strOrNull(r.store_date),
    foc_date: strOrNull(r.foc_date), image: strOrNull(r.image), cover_hash: str(r.cover_hash),
    modified: strOrNull(r.modified), issue_name: str(r.issue), series: basicSeries(r.series),
  };
  if ("cv_id" in r) out.cv_id = num(r.cv_id);
  if ("gcd_id" in r) out.gcd_id = num(r.gcd_id);
  return out;
}

export function mapIssue(r: Raw): MetronIssue {
  const s = isRecord(r.series) ? r.series : {};
  return {
    id: int(r.id), number: str(r.number), cover_date: strOrNull(r.cover_date), store_date: strOrNull(r.store_date),
    foc_date: strOrNull(r.foc_date), image: strOrNull(r.image), cover_hash: str(r.cover_hash),
    modified: strOrNull(r.modified), publisher: generic(r.publisher), imprint: generic(r.imprint),
    series: {
      id: int(s.id), name: str(s.name), sort_name: str(s.sort_name), alt_names: strings(s.alt_names),
      volume: int(s.volume, 1), year_began: int(s.year_began), series_type: generic(s.series_type),
      genres: arr(s.genres).map((g) => generic(g)!), language: str(s.language),
    },
    alt_number: str(r.alt_number), collection_title: str(r.title), story_titles: strings(r.name),
    price: num(r.price), price_currency: str(r.price_currency), rating: generic(r.rating), sku: str(r.sku),
    isbn: str(r.isbn), upc: str(r.upc), page_count: num(r.page), desc: str(r.desc), arcs: resources(r.arcs),
    credits: arr(r.credits).map((c) => ({ id: int(c.id), creator: str(c.creator), role: arr(c.role).map((x) => generic(x)!) })),
    characters: resources(r.characters), teams: resources(r.teams), universes: resources(r.universes),
    reprints: arr(r.reprints).map((x) => ({ id: int(x.id), issue: str(x.issue) })),
    variants: arr(r.variants).map((v) => ({ name: str(v.name), price: num(v.price), sku: str(v.sku), upc: str(v.upc),
                                             image: strOrNull(v.image) })),
    average_rating: num(r.average_rating), rating_count: int(r.rating_count), cv_id: num(r.cv_id),
    gcd_id: num(r.gcd_id), resource_url: str(r.resource_url),
  };
}

export function mapArc(r: Raw): MetronArc {
  return { ...resource(r), desc: str(r.desc), image: strOrNull(r.image), cv_id: num(r.cv_id), gcd_id: num(r.gcd_id),
           resource_url: str(r.resource_url) };
}

export function mapCharacter(r: Raw): MetronCharacter {
  return { ...resource(r), alias: Array.isArray(r.alias) ? strings(r.alias) : null, desc: str(r.desc),
           image: strOrNull(r.image), creators: resources(r.creators), teams: resources(r.teams),
           universes: resources(r.universes), cv_id: num(r.cv_id), gcd_id: num(r.gcd_id),
           resource_url: str(r.resource_url) };
}

export function mapTeam(r: Raw): MetronTeam {
  return { ...resource(r), desc: str(r.desc), image: strOrNull(r.image), creators: resources(r.creators),
           universes: resources(r.universes), cv_id: num(r.cv_id), gcd_id: num(r.gcd_id),
           resource_url: str(r.resource_url) };
}

const user = (v: unknown): MetronUser | null => (isRecord(v) ? { id: int(v.id), username: str(v.username) } : null);
const nav = (v: unknown): MetronReadingListNav | null => (isRecord(v) ? { id: int(v.id), name: str(v.name) } : null);

export function mapReadingList(r: Raw): MetronReadingList {
  return {
    id: int(r.id), user: user(r.user), name: str(r.name), slug: str(r.slug), desc: str(r.desc),
    image: strOrNull(r.image), list_type: str(r.list_type), is_private: Boolean(r.is_private),
    // mokkari turns "" into None for both attribution fields (list rows) / the URL (detail)
    attribution_source: strOrNull(r.attribution_source), attribution_url: strOrNull(r.attribution_url),
    previous: nav(r.previous), next: nav(r.next), average_rating: num(r.average_rating),
    rating_count: int(r.rating_count), items_url: str(r.items_url), resource_url: str(r.resource_url),
    modified: strOrNull(r.modified),
  };
}

export function mapReadingListListItem(r: Raw): MetronReadingListListItem {
  return { id: int(r.id), name: str(r.name), slug: str(r.slug), user: user(r.user), list_type: str(r.list_type),
           is_private: Boolean(r.is_private), attribution_source: strOrNull(r.attribution_source),
           average_rating: num(r.average_rating), rating_count: int(r.rating_count), modified: strOrNull(r.modified) };
}

export function mapReadingListItem(r: Raw): MetronReadingListItem {
  const i = isRecord(r.issue) ? r.issue : {};
  return {
    id: int(r.id), order: num(r.order), issue_type: str(r.issue_type),
    issue: { id: int(i.id), series: basicSeries(i.series), number: str(i.number), cover_date: strOrNull(i.cover_date),
             store_date: strOrNull(i.store_date), cv_id: num(i.cv_id), gcd_id: num(i.gcd_id),
             modified: strOrNull(i.modified) },
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

/** Metron's 429 without Retry-After: assume a full burst window (as mokkari does). */
const DEFAULT_BURST_PERIOD_S = 60;

export function metronAuthHeader(auth: MetronAuth): string {
  // mokkari: api_token → "Bearer <token>"; username/passwd → requests' HTTP Basic auth
  if ("token" in auth) return `Bearer ${auth.token}`;
  return `Basic ${base64Utf8(`${auth.username}:${auth.password}`)}`;
}

export function createMetronPacer(clock?: Clock): Pacer {
  return new Pacer({ name: "Metron", minIntervalMs: METRON_MIN_INTERVAL_MS, clock });
}

export type MetronClient = ReturnType<typeof createMetronClient>;

export function createMetronClient(opts: MetronClientOptions) {
  const base = opts.baseUrl ?? METRON_API;
  const pacer = opts.pacer ?? createMetronPacer(opts.clock);
  const ttl = opts.cacheTtlSeconds ?? 86_400;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json", Authorization: metronAuthHeader(opts.auth) };
  const rateLimit: MetronRateLimitStatus = {
    burst: { limit: null, remaining: null, reset: null },
    sustained: { limit: null, remaining: null, reset: null },
  };

  /** Reads X-RateLimit-* like mokkari and closes the pacer gate when a window is exhausted. */
  function observeHeaders(h: Record<string, string>): void {
    const window = (prefix: string) => {
      const limit = num(h[`x-ratelimit-${prefix}-limit`]);
      const remaining = num(h[`x-ratelimit-${prefix}-remaining`]);
      const reset = num(h[`x-ratelimit-${prefix}-reset`]);
      return { limit, remaining, reset: reset == null ? null : reset * 1000 };
    };
    const burst = window("burst");
    const sustained = window("sustained");
    if (burst.limit != null || burst.remaining != null || burst.reset != null) rateLimit.burst = burst;
    if (sustained.limit != null || sustained.remaining != null || sustained.reset != null) rateLimit.sustained = sustained;
    const now = pacer.clock.now();
    if (burst.limit) pacer.minIntervalMs = Math.max(pacer.minIntervalMs, Math.ceil(60_000 / burst.limit));
    if (burst.remaining === 0 && burst.reset != null && burst.reset > now) {
      pacer.blockUntil(Math.min(burst.reset, now + pacer.maxWaitMs));
    }
    if (sustained.remaining === 0 && sustained.reset != null && sustained.reset > now) {
      pacer.blockUntil(sustained.reset);
    }
  }

  function dailyLimitError(): RateLimitError | null {
    const s = rateLimit.sustained;
    const now = pacer.clock.now();
    if (s.remaining !== 0 || s.reset == null || s.reset <= now) return null;
    const seconds = Math.ceil((s.reset - now) / 1000);
    const limit = s.limit != null ? s.limit.toLocaleString("en-US") : "your";
    return new RateLimitError(`Metron: you have reached the ${limit} requests per day limit; ` +
                              `try again in ${formatSeconds(seconds)}`, seconds);
  }

  /** One GET (cache → pacer → HTTP). `null` = 404 when `nullOn404`. */
  async function getJson(url: string, params: MetronParams | undefined, nullOn404: boolean): Promise<Raw | null> {
    return cachedGet(opts.cache, cacheKey(url, params), ttl, async () => {
      const daily = dailyLimitError();
      if (daily) throw daily;
      let res;
      try {
        res = await pacedRequest(opts.http, pacer, { url, params, headers, responseType: "json" },
                                 { defaultRetryAfterSeconds: DEFAULT_BURST_PERIOD_S,
                                   onResponse: (r) => observeHeaders(r.headers) });
      } catch (err) {
        // a 429 from the daily window carries its headers: report it as the daily limit
        throw (err instanceof RateLimitError && dailyLimitError()) || err;
      }
      const body = res.data;
      const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : undefined;
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`Metron rejected the credentials (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
      }
      if (res.status === 404) {
        if (nullOn404) return null;
        throw new NotFoundError(`Metron: ${url} not found`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new SourceError(`Metron HTTP ${res.status} for ${url}${detail ? `: ${detail}` : ""}`, res.status);
      }
      if (!isRecord(body)) throw new SourceError(`Metron returned a non-JSON response for ${url}`, res.status);
      if (detail !== undefined) throw new SourceError(`Metron: ${detail}`, res.status);
      return body;
    });
  }

  const endpoint = (...parts: (string | number)[]) => `${base}${parts.join("/")}/`;

  async function detail<T>(resourceName: string, id: number, map: (r: Raw) => T): Promise<T | null> {
    const raw = await getJson(endpoint(resourceName, id), undefined, true);
    return raw ? map(raw) : null;
  }

  /** All pages of a list endpoint, following `next` (each page cached under its own URL). */
  async function list<T>(parts: (string | number)[], params: MetronParams | undefined, map: (r: Raw) => T): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = endpoint(...parts);
    let pageParams: MetronParams | undefined = params;
    const seen = new Set<string>();
    while (url) {
      const page: Raw | null = await getJson(url, pageParams, false);
      out.push(...arr(page?.results).map(map));
      const next: string | null = typeof page?.next === "string" && page.next ? page.next : null;
      if (next && seen.has(next)) break; // defensive: a looping `next` must not spin forever
      if (next) seen.add(next);
      url = next;
      pageParams = undefined; // `next` already carries the query string
    }
    return out;
  }

  return {
    pacer,
    /** Rate-limit state from the latest Metron response headers */
    get rateLimitStatus(): MetronRateLimitStatus { return jsonClone(rateLimit); },

    publisher: (id: number) => detail("publisher", id, mapPublisher),
    publishersList: (params?: MetronParams) => list(["publisher"], params, resource),
    universe: (id: number) => detail("universe", id, mapUniverse),
    universesList: (params?: MetronParams) => list(["universe"], params, resource),
    series: (id: number) => detail("series", id, mapSeries),
    seriesList: (params?: MetronParams) => list(["series"], params, mapSeriesListItem),
    seriesIssuesList: (id: number) => list(["series", id, "issue_list"], undefined, mapIssueListItem),
    issue: (id: number) => detail("issue", id, mapIssue),
    issuesList: (params?: MetronParams) => list(["issue"], params, mapIssueListItem),
    arc: (id: number) => detail("arc", id, mapArc),
    arcsList: (params?: MetronParams) => list(["arc"], params, resource),
    arcIssuesList: (id: number) => list(["arc", id, "issue_list"], undefined, mapIssueListItem),
    character: (id: number) => detail("character", id, mapCharacter),
    charactersList: (params?: MetronParams) => list(["character"], params, resource),
    characterIssuesList: (id: number) => list(["character", id, "issue_list"], undefined, mapIssueListItem),
    team: (id: number) => detail("team", id, mapTeam),
    teamsList: (params?: MetronParams) => list(["team"], params, resource),
    teamIssuesList: (id: number) => list(["team", id, "issue_list"], undefined, mapIssueListItem),
    readingList: (id: number) => detail("reading_list", id, mapReadingList),
    readingListsList: (params?: MetronParams) => list(["reading_list"], params, mapReadingListListItem),
    readingListItems: (id: number) => list(["reading_list", id, "items"], undefined, mapReadingListItem),
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Validates credentials with one small uncached request (a name filter that matches nothing,
 * so Metron answers with an empty page but still checks auth).
 */
export async function testMetron(opts: Omit<MetronClientOptions, "cache">): Promise<SourceTestResult> {
  const client = createMetronClient({ ...opts, cache: undefined, cacheTtlSeconds: 0 });
  try {
    await client.publishersList({ name: "comixcenter-credential-check" });
    return { ok: true, message: "Metron credentials accepted" };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, message: "Metron rejected the username/password or token" };
    if (err instanceof RateLimitError) return { ok: false, message: err.message };
    return { ok: false, message: `Metron check failed: ${(err as Error).message}` };
  }
}
