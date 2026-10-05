/**
 * Comic Vine client, a TypeScript stand-in for simyan's `Comicvine`.
 *
 * Same requests as simyan: `GET https://comicvine.gamespot.com/api/{resource}/{type}-{id}/` and
 * `/search/?query=…&resources=…&page=N`, always with `api_key` and `format=json`, no `field_list`.
 * Objects come back with simyan's *Python attribute names* (aliases resolved), e.g. raw
 * `issues_died_in` → `deaths`, `first_appeared_in_issue` → `first_issue`, team `characters` →
 * `members`, `deck` → `summary`, `issue_number` → `number`, `api_detail_url` → `api_url`.
 * `aliases` stays the raw newline-separated string (the sync splits it).
 *
 * Errors follow simyan, plus finer types: JSON `status_code` 100 (invalid key) → AuthError,
 * 101 (object not found) → NotFoundError, 107 (rate limit) → RateLimitError, other codes →
 * SourceError; HTTP 401 → AuthError, 404 → NotFoundError, 420/429 → RateLimitError.
 */
import { AuthError, NotFoundError, RateLimitError, SourceError } from "../contracts";
import type { HttpFn, HttpResponse, ResponseCache } from "../contracts";
import { cachedGet, cacheKey, isRecord, Pacer, pacedRequest, USER_AGENT } from "./http";
import type { Clock, SourceTestResult } from "./http";

export const COMICVINE_API = "https://comicvine.gamespot.com/api";

/** CV's velocity detection trips at more than ~1 request/second. */
export const COMICVINE_MIN_INTERVAL_MS = 1_100;

/** Resource type ids used in detail URLs ("4005-1443") */
export const CV_RESOURCES = {
  issue: { typeId: 4000, singular: "issue", plural: "issues" },
  character: { typeId: 4005, singular: "character", plural: "characters" },
  story_arc: { typeId: 4045, singular: "story_arc", plural: "story_arcs" },
  volume: { typeId: 4050, singular: "volume", plural: "volumes" },
  team: { typeId: 4060, singular: "team", plural: "teams" },
} as const;

type CvResource = keyof typeof CV_RESOURCES;

/** CV's hourly per-resource window; used when a refusal carries no Retry-After. */
const RATE_LIMIT_RETRY_S = 3_600;

export interface ComicVineClientOptions {
  http: HttpFn;
  apiKey: string;
  cache?: ResponseCache;
  pacer?: Pacer;
  /** Seconds a cached response stays valid (default 14 days, like simyan; 0 disables) */
  cacheTtlSeconds?: number;
  clock?: Clock;
  baseUrl?: string;
}

// ── Returned shapes (simyan attribute names) ─────────────────────────────────

export interface CvEntry { api_url: string; id: number; name: string | null; site_url: string | null }
export interface CvIssueEntry extends CvEntry { number: string | null }
export interface CvCreatorEntry extends CvEntry { roles: string }
export interface CvCountEntry extends CvEntry { count: number }

export interface CvImages {
  icon_url: string; large_screen_url: string; medium_url: string; original_url: string; screen_url: string;
  small_url: string; super_url: string; thumbnail: string; tiny_url: string; tags: string | null;
}

export interface CvAssociatedImage { url: string; id: number; caption: string | null; tags: string | null }

interface CvCommon {
  aliases: string | null; api_url: string; date_added: string | null; date_last_updated: string | null;
  description: string | null; id: number; image: CvImages | null; site_url: string | null; summary: string | null;
}

export interface CvBasicCharacter extends CvCommon {
  date_of_birth: string | null; first_issue: CvIssueEntry | null; gender: number; issue_count: number; name: string;
  origin: CvEntry | null; publisher: CvEntry | null; real_name: string | null;
}

export interface CvCharacter extends CvBasicCharacter {
  creators: CvEntry[]; deaths: CvEntry[]; enemies: CvEntry[]; enemy_teams: CvEntry[]; friendly_teams: CvEntry[];
  friends: CvEntry[]; issues: CvEntry[]; powers: CvEntry[]; story_arcs: CvEntry[]; teams: CvEntry[]; volumes: CvEntry[];
}

export interface CvBasicIssue extends CvCommon {
  associated_images: CvAssociatedImage[]; cover_date: string | null; name: string | null; number: string | null;
  store_date: string | null; volume: CvEntry | null;
}

export interface CvIssue extends CvBasicIssue {
  characters: CvEntry[]; concepts: CvEntry[]; creators: CvCreatorEntry[]; deaths: CvEntry[];
  first_appearance_characters: CvEntry[]; first_appearance_concepts: CvEntry[]; first_appearance_locations: CvEntry[];
  first_appearance_objects: CvEntry[]; first_appearance_story_arcs: CvEntry[]; first_appearance_teams: CvEntry[];
  locations: CvEntry[]; objects: CvEntry[]; story_arcs: CvEntry[]; teams: CvEntry[]; teams_disbanded: CvEntry[];
}

export interface CvBasicTeam extends CvCommon {
  first_issue: CvIssueEntry | null; issue_count: number; member_count: number; name: string; publisher: CvEntry | null;
}

export interface CvTeam extends CvBasicTeam {
  enemies: CvEntry[]; friends: CvEntry[]; issues: CvEntry[]; issues_disbanded_in: CvEntry[]; members: CvEntry[];
  story_arcs: CvEntry[]; volumes: CvEntry[];
}

export interface CvBasicStoryArc extends CvCommon {
  first_issue: CvIssueEntry | null; issue_count: number; name: string; publisher: CvEntry | null;
}

export interface CvStoryArc extends CvBasicStoryArc { issues: CvEntry[] }

export interface CvBasicVolume extends CvCommon {
  first_issue: CvIssueEntry | null; issue_count: number; last_issue: CvIssueEntry | null; name: string;
  publisher: CvEntry | null; start_year: number | null;
}

export interface CvVolume extends CvBasicVolume {
  characters: CvCountEntry[]; concepts: CvCountEntry[]; creators: CvCountEntry[]; issues: CvIssueEntry[];
  locations: CvCountEntry[]; objects: CvCountEntry[];
}

// ── Raw JSON → simyan attributes ─────────────────────────────────────────────

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === "" ? null : str(v));
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown, fallback = 0): number => num(v) ?? fallback;
/** simyan turns blank strings (CV's "nothing" for some list fields) into empty lists */
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** "2008-06-06 11:08:00" → "2008-06-06T11:08:00" (ISO, CV's server-local time) */
const dateTime = (v: unknown): string | null => {
  const s = strOrNull(v);
  return s ? s.replace(" ", "T") : null;
};
/** CV dates are "YYYY-MM-DD"; keep only that part */
const date = (v: unknown): string | null => {
  const s = strOrNull(v);
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** Character `birth` is "Aug 10, 1962" (simyan parses "%b %d, %Y") → "1962-08-10" */
export function parseCvBirth(v: unknown): string | null {
  const m = strOrNull(v)?.trim().match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  const month = m && MONTHS[m[1].toLowerCase()];
  return m && month ? `${m[3]}-${month}-${m[2].padStart(2, "0")}` : null;
}

export function mapEntry(r: Raw): CvEntry {
  return { api_url: str(r.api_detail_url), id: int(r.id), name: strOrNull(r.name), site_url: strOrNull(r.site_detail_url) };
}
const entry = (v: unknown): CvEntry | null => (isRecord(v) ? mapEntry(v) : null);
const entries = (v: unknown): CvEntry[] => arr(v).map(mapEntry);
const issueEntry = (v: unknown): CvIssueEntry | null =>
  isRecord(v) ? { ...mapEntry(v), number: strOrNull(v.issue_number) } : null;

export function mapImages(v: unknown): CvImages | null {
  if (!isRecord(v)) return null;
  return {
    icon_url: str(v.icon_url), large_screen_url: str(v.screen_large_url), medium_url: str(v.medium_url),
    original_url: str(v.original_url), screen_url: str(v.screen_url), small_url: str(v.small_url),
    super_url: str(v.super_url), thumbnail: str(v.thumb_url), tiny_url: str(v.tiny_url), tags: strOrNull(v.image_tags),
  };
}

function common(r: Raw): CvCommon {
  return {
    aliases: strOrNull(r.aliases), api_url: str(r.api_detail_url), date_added: dateTime(r.date_added),
    date_last_updated: dateTime(r.date_last_updated), description: strOrNull(r.description), id: int(r.id),
    image: mapImages(r.image), site_url: strOrNull(r.site_detail_url), summary: strOrNull(r.deck),
  };
}

export function mapBasicCharacter(r: Raw): CvBasicCharacter {
  return {
    ...common(r), date_of_birth: parseCvBirth(r.birth), first_issue: issueEntry(r.first_appeared_in_issue),
    gender: int(r.gender), issue_count: int(r.count_of_issue_appearances), name: str(r.name),
    origin: entry(r.origin), publisher: entry(r.publisher), real_name: strOrNull(r.real_name),
  };
}

export function mapCharacter(r: Raw): CvCharacter {
  return {
    ...mapBasicCharacter(r), creators: entries(r.creators), deaths: entries(r.issues_died_in),
    enemies: entries(r.character_enemies), enemy_teams: entries(r.team_enemies), friendly_teams: entries(r.team_friends),
    friends: entries(r.character_friends), issues: entries(r.issue_credits), powers: entries(r.powers),
    story_arcs: entries(r.story_arc_credits), teams: entries(r.teams), volumes: entries(r.volume_credits),
  };
}

export function mapBasicIssue(r: Raw): CvBasicIssue {
  return {
    ...common(r),
    associated_images: arr(r.associated_images).map((a) => ({ url: str(a.original_url), id: int(a.id),
                                                               caption: strOrNull(a.caption), tags: strOrNull(a.image_tags) })),
    cover_date: date(r.cover_date), name: strOrNull(r.name), number: strOrNull(r.issue_number),
    store_date: date(r.store_date), volume: entry(r.volume),
  };
}

export function mapIssue(r: Raw): CvIssue {
  return {
    ...mapBasicIssue(r), characters: entries(r.character_credits), concepts: entries(r.concept_credits),
    creators: arr(r.person_credits).map((p) => ({ ...mapEntry(p), roles: str(p.role) })),
    deaths: entries(r.character_died_in), first_appearance_characters: entries(r.first_appearance_characters),
    first_appearance_concepts: entries(r.first_appearance_concepts),
    first_appearance_locations: entries(r.first_appearance_locations),
    first_appearance_objects: entries(r.first_appearance_objects),
    first_appearance_story_arcs: entries(r.first_appearance_storyarcs),
    first_appearance_teams: entries(r.first_appearance_teams), locations: entries(r.location_credits),
    objects: entries(r.object_credits), story_arcs: entries(r.story_arc_credits), teams: entries(r.team_credits),
    teams_disbanded: entries(r.team_disbanded_in),
  };
}

export function mapBasicTeam(r: Raw): CvBasicTeam {
  return {
    // CV really spells it "count_of_isssue_appearances" for teams and story arcs
    ...common(r), first_issue: issueEntry(r.first_appeared_in_issue), issue_count: int(r.count_of_isssue_appearances),
    member_count: int(r.count_of_team_members), name: str(r.name), publisher: entry(r.publisher),
  };
}

export function mapTeam(r: Raw): CvTeam {
  return {
    ...mapBasicTeam(r), enemies: entries(r.character_enemies), friends: entries(r.character_friends),
    issues: entries(r.issue_credits), issues_disbanded_in: entries(r.disbanded_in_issues), members: entries(r.characters),
    story_arcs: entries(r.story_arc_credits), volumes: entries(r.volume_credits),
  };
}

export function mapBasicStoryArc(r: Raw): CvBasicStoryArc {
  return { ...common(r), first_issue: issueEntry(r.first_appeared_in_issue), issue_count: int(r.count_of_isssue_appearances),
           name: str(r.name), publisher: entry(r.publisher) };
}

export function mapStoryArc(r: Raw): CvStoryArc {
  return { ...mapBasicStoryArc(r), issues: entries(r.issues) };
}

export function mapBasicVolume(r: Raw): CvBasicVolume {
  return {
    ...common(r), first_issue: issueEntry(r.first_issue), issue_count: int(r.count_of_issues),
    last_issue: issueEntry(r.last_issue), name: str(r.name), publisher: entry(r.publisher),
    start_year: num(typeof r.start_year === "string" ? r.start_year.trim() : r.start_year),
  };
}

export function mapVolume(r: Raw): CvVolume {
  const counts = (v: unknown): CvCountEntry[] => arr(v).map((c) => ({ ...mapEntry(c), count: int(c.count) }));
  return {
    ...mapBasicVolume(r), characters: counts(r.characters), concepts: counts(r.concepts), creators: counts(r.people),
    issues: arr(r.issues).map((i) => issueEntry(i)!), locations: counts(r.locations), objects: counts(r.objects),
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

export function createComicVinePacer(clock?: Clock): Pacer {
  return new Pacer({ name: "Comic Vine", minIntervalMs: COMICVINE_MIN_INTERVAL_MS, clock });
}

/** Maps a CV answer to an error, or null when it is a success (`status_code` 1). */
export function comicVineError(res: HttpResponse, url: string): Error | null {
  const body = isRecord(res.data) ? res.data : undefined;
  const code = body ? num(body.status_code) : null;
  const message = body && typeof body.error === "string" ? body.error : "";
  if (code === 1 && res.status >= 200 && res.status < 300) return null;
  if (code === 100) return new AuthError(`Comic Vine: ${message || "Invalid API Key"}`);
  if (code === 101) return new NotFoundError(`Comic Vine: ${message || "Object Not Found"} (${url})`);
  if (code === 107) return new RateLimitError(`Comic Vine: ${message || "Rate limit exceeded"}`, RATE_LIMIT_RETRY_S);
  if (res.status === 401 || res.status === 403) return new AuthError(`Comic Vine rejected the API key (HTTP ${res.status})`);
  if (res.status === 404) return new NotFoundError(`Comic Vine: ${url} not found`);
  if (code != null) return new SourceError(`Comic Vine error ${code}: ${message || "unknown"}`, res.status);
  if (res.status < 200 || res.status >= 300) return new SourceError(`Comic Vine HTTP ${res.status} for ${url}`, res.status);
  return new SourceError(`Comic Vine returned an unexpected response for ${url}`, res.status);
}

export type ComicVineClient = ReturnType<typeof createComicVineClient>;

export function createComicVineClient(opts: ComicVineClientOptions) {
  const base = opts.baseUrl ?? COMICVINE_API;
  const pacer = opts.pacer ?? createComicVinePacer(opts.clock);
  const ttl = opts.cacheTtlSeconds ?? 14 * 86_400;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };

  async function request(endpoint: string, extra: Record<string, string | number> = {}): Promise<Raw> {
    const url = `${base}${endpoint}`;
    const params = { api_key: opts.apiKey, format: "json", ...extra };
    // the key is a credential: never part of the cache key (simyan: ignored_parameters=["api_key"])
    return cachedGet(opts.cache, cacheKey(url, params, ["api_key"]), ttl, async () => {
      const res = await pacedRequest(opts.http, pacer, { url, params, headers, responseType: "json" }, {
        rateLimitStatuses: [420, 429],
        defaultRetryAfterSeconds: RATE_LIMIT_RETRY_S,
        // CV limits are per resource type, so one refusal must not stall the other resources
        blockOnRefusal: false,
      });
      const err = comicVineError(res, url);
      if (err) throw err;
      return res.data as Raw;
    });
  }

  async function get<T>(resource: CvResource, id: number, map: (r: Raw) => T): Promise<T> {
    const { typeId, singular } = CV_RESOURCES[resource];
    const body = await request(`/${singular}/${typeId}-${id}/`);
    if (!isRecord(body.results)) throw new NotFoundError(`Comic Vine: ${singular} ${id} not found`);
    return map(body.results);
  }

  /** simyan `_search`: `/search/` paged by `page` until `number_of_total_results` or `maxResults`. */
  async function search<T>(resource: CvResource, query: string, maxResults: number, map: (r: Raw) => T): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const body = await request("/search/", { query, resources: CV_RESOURCES[resource].singular, page });
      const results = arr(body.results);
      if (!results.length) break;
      out.push(...results.map(map));
      if (out.length >= maxResults) return out.slice(0, maxResults);
      if (out.length >= int(body.number_of_total_results)) break;
    }
    return out;
  }

  /** Every issue of a volume with its cover, oldest first, 100 per request. */
  async function volumeIssues(volumeId: number): Promise<CvBasicIssue[]> {
    const out: CvBasicIssue[] = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const body = await request("/issues/", { filter: `volume:${volumeId}`, field_list: "id,issue_number,name,image,cover_date,store_date,volume",
                                               sort: "cover_date:asc", limit: 100, offset });
      const results = arr(body.results);
      out.push(...results.map(mapBasicIssue));
      if (!results.length || out.length >= int(body.number_of_total_results)) break;
    }
    return out;
  }

  return {
    pacer,
    volumeIssues,
    getCharacter: (id: number) => get("character", id, mapCharacter),
    getIssue: (id: number) => get("issue", id, mapIssue),
    getTeam: (id: number) => get("team", id, mapTeam),
    getStoryArc: (id: number) => get("story_arc", id, mapStoryArc),
    getVolume: (id: number) => get("volume", id, mapVolume),
    /** Defaults to 50 results (simyan uses 500, i.e. up to 50 requests at ~1/s) */
    searchCharacters: (query: string, maxResults = 50) => search("character", query, maxResults, mapBasicCharacter),
    searchVolumes: (query: string, maxResults = 50) => search("volume", query, maxResults, mapBasicVolume),
    searchStoryArcs: (query: string, maxResults = 50) => search("story_arc", query, maxResults, mapBasicStoryArc),
    searchTeams: (query: string, maxResults = 50) => search("team", query, maxResults, mapBasicTeam),
  };
}

/** Validates the API key with one small uncached request (a search page with a single result). */
export async function testComicVine(opts: Omit<ComicVineClientOptions, "cache">): Promise<SourceTestResult> {
  const client = createComicVineClient({ ...opts, cache: undefined, cacheTtlSeconds: 0 });
  try {
    await client.searchVolumes("spider-man", 1);
    return { ok: true, message: "Comic Vine API key accepted" };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, message: "Comic Vine rejected the API key" };
    if (err instanceof RateLimitError) return { ok: false, message: err.message };
    return { ok: false, message: `Comic Vine check failed: ${(err as Error).message}` };
  }
}
