/**
 * Grand Comics Database (comics.org) client — keyless public REST API — plus parsers for the
 * free-text credit and character fields of its stories.
 *
 * GCD sits behind Cloudflare and throttles anonymous clients hard. Observed while building this:
 * ~14 requests at 4–10s spacing were followed by `429 {"detail":"Request was throttled. Expected
 * available in 2895 seconds."}` with `Retry-After: 2895`, i.e. there is a quota well beyond the
 * burst limit. Hence: 3.5s spacing, aggressive caching (issues 30 days) and a RateLimitError that
 * closes the gate for every caller when the wait is long.
 *
 * Objects keep GCD's own field names and gain parsed ids: `id` (from `api_url`), `series_id` /
 * `variant_of_id` on issues, `publisher_id` and `active_issue_ids` on series (same order as
 * `issue_descriptors`), and `cover_date` ("YYYY-MM-DD", from `key_date` "1988-05-00").
 */
import { AuthError, NotFoundError, SourceError } from "../contracts";
import type { HttpFn, ResponseCache } from "../contracts";
import { base64Utf8, cachedGet, cacheKey, isRecord, Pacer, pacedRequest, USER_AGENT } from "./http";
import type { Clock } from "./http";

export const GCD_API = "https://www.comics.org/api/";
export const GCD_MIN_INTERVAL_MS = 3_500;

const DAY = 86_400;
export const GCD_TTL = { issue: 30 * DAY, series: 7 * DAY, publisher: 30 * DAY, search: DAY } as const;

export interface GcdClientOptions {
  http: HttpFn;
  cache?: ResponseCache;
  pacer?: Pacer;
  clock?: Clock;
  baseUrl?: string;
  /** Override cache lifetimes (seconds; 0 disables) */
  ttl?: Partial<Record<keyof typeof GCD_TTL, number>>;
  /**
   * A free comics.org account. The API accepts HTTP Basic auth, and signed-in clients are
   * throttled per account instead of sharing the anonymous quota of their IP address.
   */
  auth?: { username: string; password: string } | null;
}

// ── Returned shapes (GCD field names + parsed ids) ───────────────────────────

export interface GcdStory {
  type: string; title: string; feature: string; sequence_number: number; page_count: string | null;
  script: string; pencils: string; inks: string; colors: string; letters: string; editing: string;
  job_number: string; genre: string; first_line: string; characters: string; synopsis: string; notes: string;
  keywords: string;
  [key: string]: unknown;
}

export interface GcdIssue {
  id: number; api_url: string; series_name: string; descriptor: string; number: string; volume: string;
  variant_name: string; title: string; publication_date: string; key_date: string; price: string;
  page_count: string | null; editing: string; indicia_publisher: string; brand_emblem: string; isbn: string;
  barcode: string; rating: string; on_sale_date: string; indicia_frequency: string; notes: string;
  variant_of: string | null; series: string; indicia_printer: string; keywords: string; cover: string;
  story_set: GcdStory[];
  series_id: number | null; variant_of_id: number | null;
  /** key_date with unknown day/month set to 01, or null */
  cover_date: string | null;
  [key: string]: unknown;
}

export interface GcdSeries {
  id: number; api_url: string; name: string; country: string; language: string; active_issues: string[];
  issue_descriptors: string[]; color: string; dimensions: string; paper_stock: string; binding: string;
  publishing_format: string; notes: string; year_began: number | null; year_ended: number | null; publisher: string;
  publisher_id: number | null; active_issue_ids: number[];
  [key: string]: unknown;
}

export interface GcdPublisher { id: number; api_url: string; name: string; [key: string]: unknown }

export interface GcdPage<T> { count: number; next: string | null; previous: string | null; results: T[] }

// ── Mapping ──────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

/** Numeric id at the end of a GCD API URL ("…/api/issue/44451/?format=json" → 44451). */
export function gcdIdFromUrl(url: unknown): number | null {
  if (typeof url !== "string") return null;
  const m = url.match(/\/(\d+)\/?(?:[?#].*)?$/);
  return m ? Number(m[1]) : null;
}

/** "1988-05-00" → "1988-05-01"; "1940-00-00" → "1940-01-01"; anything else → null */
export function gcdKeyDateToDate(keyDate: unknown): string | null {
  const m = typeof keyDate === "string" ? keyDate.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!m || m[1] === "0000") return null;
  const fix = (v: string) => (v === "00" ? "01" : v);
  return `${m[1]}-${fix(m[2])}-${fix(m[3])}`;
}

export function mapGcdIssue(r: Raw): GcdIssue {
  return {
    ...r,
    story_set: Array.isArray(r.story_set) ? (r.story_set.filter(isRecord) as GcdStory[]) : [],
    id: gcdIdFromUrl(r.api_url) ?? 0,
    series_id: gcdIdFromUrl(r.series),
    variant_of_id: gcdIdFromUrl(r.variant_of),
    cover_date: gcdKeyDateToDate(r.key_date),
  } as unknown as GcdIssue;
}

export function mapGcdSeries(r: Raw): GcdSeries {
  const active = Array.isArray(r.active_issues) ? r.active_issues.map(String) : [];
  return {
    ...r,
    active_issues: active,
    issue_descriptors: Array.isArray(r.issue_descriptors) ? r.issue_descriptors.map(String) : [],
    id: gcdIdFromUrl(r.api_url) ?? 0,
    publisher_id: gcdIdFromUrl(r.publisher),
    active_issue_ids: active.map(gcdIdFromUrl).filter((v): v is number => v != null),
  } as unknown as GcdSeries;
}

export function mapGcdPublisher(r: Raw): GcdPublisher {
  return { ...r, id: gcdIdFromUrl(r.api_url) ?? 0 } as unknown as GcdPublisher;
}

// ── Client ───────────────────────────────────────────────────────────────────

export function createGcdPacer(clock?: Clock): Pacer {
  return new Pacer({ name: "Grand Comics Database", minIntervalMs: GCD_MIN_INTERVAL_MS, clock });
}

export type GcdClient = ReturnType<typeof createGcdClient>;

export function createGcdClient(opts: GcdClientOptions) {
  const base = opts.baseUrl ?? GCD_API;
  const pacer = opts.pacer ?? createGcdPacer(opts.clock);
  const ttl = { ...GCD_TTL, ...opts.ttl };
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
  if (opts.auth) headers.Authorization = `Basic ${base64Utf8(`${opts.auth.username}:${opts.auth.password}`)}`;

  /** GET a URL (absolute) with format=json; `null` for 404 when `nullOn404`. */
  async function getJson(url: string, ttlSeconds: number, nullOn404: boolean): Promise<Raw | null> {
    const params = /[?&]format=/.test(url) ? undefined : { format: "json" };
    return cachedGet(opts.cache, cacheKey(url, params), ttlSeconds, async () => {
      const res = await pacedRequest(opts.http, pacer, { url, params, headers, responseType: "json" },
                                     { defaultRetryAfterSeconds: 60 });
      const detail = isRecord(res.data) && typeof res.data.detail === "string" ? res.data.detail : "";
      if (res.status === 401 || (res.status === 403 && opts.auth)) {
        throw new AuthError(`Grand Comics Database rejected your username or password${detail ? ` (${detail})` : ""}`);
      }
      if (res.status === 404) {
        if (nullOn404) return null;
        throw new NotFoundError(`GCD: ${url} not found`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new SourceError(`GCD HTTP ${res.status} for ${url}${detail ? `: ${detail}` : ""}`, res.status);
      }
      if (!isRecord(res.data)) {
        // Cloudflare challenges come back as HTML with status 200/403
        throw new SourceError(`GCD returned a non-JSON response for ${url}`, res.status);
      }
      return res.data;
    });
  }

  async function detail<T>(path: string, ttlSeconds: number, map: (r: Raw) => T): Promise<T | null> {
    const raw = await getJson(`${base}${path}`, ttlSeconds, true);
    return raw ? map(raw) : null;
  }

  async function page<T>(url: string, ttlSeconds: number, map: (r: Raw) => T): Promise<GcdPage<T>> {
    const raw = (await getJson(url, ttlSeconds, false))!;
    return {
      count: Number(raw.count ?? 0),
      next: typeof raw.next === "string" && raw.next ? raw.next : null,
      previous: typeof raw.previous === "string" && raw.previous ? raw.previous : null,
      results: (Array.isArray(raw.results) ? raw.results.filter(isRecord) : []).map(map),
    };
  }

  /**
   * Series whose name *contains* `name` (GCD matches substrings: "House of X" also finds
   * "House of X / Powers of X"), optionally starting in `year`. Follows `next` up to `maxPages`.
   * Names containing "/" may not be searchable: GCD's router sees an encoded slash as a separator.
   */
  async function seriesByName(name: string, year?: number | null, maxPages = 5): Promise<GcdSeries[]> {
    const path = `series/name/${encodeURIComponent(name)}/` + (year ? `year/${year}/` : "");
    const out: GcdSeries[] = [];
    let url: string | null = `${base}${path}`;
    for (let i = 0; url && i < maxPages; i++) {
      const p: GcdPage<GcdSeries> = await page(url, ttl.search, mapGcdSeries);
      out.push(...p.results);
      url = p.next;
    }
    return out;
  }

  /**
   * Name search that finds the exact title even in a long result list. GCD returns every
   * substring match in alphabetical order, 50 to a page ("saga" has 568 across 12 pages), so
   * after the first page this binary-searches for the page where the title itself sorts and
   * returns that page (plus the next when prefix matches run over). ~log2(pages) requests.
   */
  async function searchSeries(name: string, year?: number | null): Promise<GcdSeries[]> {
    const path = `series/name/${encodeURIComponent(name)}/` + (year ? `year/${year}/` : "");
    const at = (n: number) => page(`${base}${path}?format=json${n > 1 ? `&page=${n}` : ""}`, ttl.search, mapGcdSeries);
    const first = await at(1);
    const size = first.results.length;
    if (!first.next || !size) return first.results;
    const pages = Math.ceil(first.count / size);
    if (pages <= 2) return [...first.results, ...(await at(2)).results];

    const want = gcdSortKey(name);
    const lastKey = (p: GcdPage<GcdSeries>) => gcdSortKey(p.results[p.results.length - 1]?.name ?? "");
    if (lastKey(first) >= want) return first.results;
    const seen = new Map<number, GcdPage<GcdSeries>>([[1, first]]);
    const get = async (n: number) => { if (!seen.has(n)) seen.set(n, await at(n)); return seen.get(n)!; };
    // Smallest page whose last title sorts at or after the query
    let lo = 2, hi = pages;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lastKey(await get(mid)) >= want) hi = mid; else lo = mid + 1;
    }
    const target = await get(lo);
    const out = [...first.results, ...target.results];
    if (lo < pages && lastKey(target).startsWith(want)) out.push(...(await get(lo + 1)).results);
    return out;
  }

  return {
    pacer,
    seriesByName,
    searchSeries,
    issue: (id: number) => detail(`issue/${id}/`, ttl.issue, mapGcdIssue),
    series: (id: number) => detail(`series/${id}/`, ttl.series, mapGcdSeries),
    publisher: (id: number) => detail(`publisher/${id}/`, ttl.publisher, mapGcdPublisher),

    /** One page of the publisher list (`page` is 1-based) */
    publishers: (pageNumber = 1) =>
      page(`${base}publisher/${pageNumber > 1 ? `?page=${pageNumber}` : ""}`, ttl.publisher, mapGcdPublisher),
  };
}

/** Approximates GCD's series ordering: case- and accent-insensitive, leading "The" ignored. */
export function gcdSortKey(name: string): string {
  return name.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().trim().replace(/^the\s+/, "");
}

// ── Credit text ──────────────────────────────────────────────────────────────

export interface GcdCredit {
  name: string;
  /** Parenthesised/bracketed notes as written: "credited", "signed as Buscema", "layouts" … */
  notes: string[];
  /** GCD marks unconfirmed attributions with a trailing "?" */
  uncertain: boolean;
}

/** Values in credit fields that are not people */
const NOT_A_CREATOR = new Set(["", "?", "none", "[none]", "various", "typeset", "unknown", "n/a", "uncredited"]);

/** Splits on `sep` outside (), [] and {} — GCD nests brackets inside entries. */
export function splitTopLevel(text: string, sep = ";"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth--;
    if (ch === sep && depth === 0) { parts.push(current); current = ""; } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Pulls the leading text and every top-level (…) / […] group out of an entry.
 * "Venom [Eddie Brock] (villain) (first full appearance)" →
 *   { head: "Venom", groups: [{kind:"[", text:"Eddie Brock"}, {kind:"(", …}, …], tail: "" }
 */
function scanEntry(text: string): { head: string; groups: { kind: "(" | "["; text: string }[]; tail: string } {
  let i = 0;
  let head = "";
  while (i < text.length && text[i] !== "(" && text[i] !== "[") head += text[i++];
  const groups: { kind: "(" | "["; text: string }[] = [];
  let tail = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(" || ch === "[") {
      const close = ch === "(" ? ")" : "]";
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text[j] === "(" || text[j] === "[") depth++;
        else if (text[j] === ")" || text[j] === "]") { depth--; if (depth === 0) break; }
      }
      if (j >= text.length || text[j] !== close) { tail += text.slice(i + 1); break; } // unbalanced: keep as text
      groups.push({ kind: ch, text: text.slice(i + 1, j).trim() });
      i = j + 1;
    } else {
      tail += ch;
      i++;
    }
  }
  return { head: head.trim(), groups, tail: tail.trim() };
}

/** Structured credits: "John Buscema (credited) (layouts); Tom Palmer ?" → name, notes, uncertain. */
export function parseGcdCreditEntries(text: string | null | undefined): GcdCredit[] {
  if (!text) return [];
  const out: GcdCredit[] = [];
  for (const part of splitTopLevel(text)) {
    const { head, groups, tail } = scanEntry(part);
    let name = `${head} ${tail}`.replace(/\s+/g, " ").trim();
    const uncertain = /\?$/.test(name) && name !== "?";
    name = name.replace(/\s*\?+$/, "").trim();
    if (NOT_A_CREATOR.has(name.toLowerCase())) continue;
    out.push({ name, notes: groups.map((g) => g.text).filter(Boolean), uncertain });
  }
  return out;
}

/**
 * Creator names from a GCD credit field ("script", "pencils", "editing" …), roles/notes in
 * parentheses or brackets removed, "None" / "?" / "[none]" / "typeset" / "various" dropped,
 * duplicates removed: "Stan Lee (credited) (plot, script); Jack Kirby ?" → ["Stan Lee", "Jack Kirby"].
 */
export function parseGcdCredits(text: string | null | undefined): string[] {
  return [...new Set(parseGcdCreditEntries(text).map((c) => c.name))];
}

// ── Character text ───────────────────────────────────────────────────────────

export type GcdRole = "featured" | "villain" | "guest" | "supporting";

export interface GcdCharacter {
  /** As written: "Spider-Man", "The Avengers", "Mary Jane Watson" */
  name: string;
  /** The person behind the mantle: "Spider-Man [Peter Parker]" → "Peter Parker" */
  person?: string;
  /** Old-style group label in force for this entry ("villains" for "Villains: Venom"), lower-cased */
  group?: string;
  /** Role from a label or a note: (featured), (villain)/(antagonist), (guest), (supporting) */
  role?: GcdRole;
  /** Written as "Team [member; member]" */
  isTeam?: boolean;
  members?: GcdCharacter[];
  /** (introduction), (first appearance), (first full appearance), "Introducing …" */
  firstAppearance?: boolean;
  /** (death), (dies), (villain, death), (all die) */
  death?: boolean;
  cameo?: boolean;
  /** Appears only in flashback: (flashback) — not "(also in flashback)" */
  flashback?: boolean;
  /** Identification marked uncertain with "?" */
  uncertain?: boolean;
  /** Remaining notes as written: "on poster", "Other Earth - Earth-6311", "joins team" … */
  notes?: string[];
}

/** "Villains:", "Guest stars:", "Featuring:" … — short alphabetic label before a colon */
const LABEL = /^([A-Za-z][A-Za-z' -]{0,38}):\s*/;
/** A description sentence pasted into the field (seen in promo pages) is not a character */
const MAX_NAME_WORDS = 8;

function roleFrom(text: string): GcdRole | undefined {
  if (/\b(villains?|antagonists?|foes?|enemies|enemy)\b/.test(text)) return "villain";
  if (/\bguest/.test(text)) return "guest";
  if (/\bsupporting\b/.test(text)) return "supporting";
  if (/\b(featur\w*|starring|stars|main|heroes|hero)\b/.test(text)) return "featured";
  return undefined;
}

const isFirstAppearance = (t: string) =>
  /^(introduc\w*|intro\b|debut|(first|1st)( full| real| cameo)? appearance|origin and first appearance)/.test(t);
const isDeath = (t: string) => /^(death|dies|dying|all die|killed|is killed)\b/.test(t) && !/\b(apparent|faked?)\b/.test(t);

const ROLE_NOTE = /^(featured|villains?|antagonists?|guest(-| )?stars?|guests?|supporting)$/;

/** Applies one note token ("villain", "first appearance", "flashback" …); unknown ones are kept in `notes`. */
function applyNote(c: GcdCharacter, raw: string): void {
  const note = raw.trim();
  const t = note.toLowerCase();
  if (!t) return;
  let understood = false;
  if (isFirstAppearance(t)) { c.firstAppearance = true; understood = true; }
  if (isDeath(t)) { c.death = true; understood = true; }
  if (/\bcameo\b/.test(t)) { c.cameo = true; understood ||= t === "cameo"; }
  if (/^(in )?flashback( only| cameo)?$/.test(t)) { c.flashback = true; understood = true; }
  const role = ROLE_NOTE.test(t) ? roleFrom(t) : undefined;
  if (role) { c.role ??= role; understood = true; }
  if (!understood) (c.notes ??= []).push(note);
}

function parseCharacterEntry(text: string, group: string | undefined): GcdCharacter | null {
  let body = text.trim();
  const c: GcdCharacter = { name: "" };
  const intro = body.match(/^introducing:?\s+/i);
  if (intro) { c.firstAppearance = true; body = body.slice(intro[0].length); }

  const { head, groups, tail } = scanEntry(body);
  let name = head.replace(/\s+/g, " ").trim();
  if (/\?$/.test(name)) { c.uncertain = true; name = name.replace(/\s*\?+$/, "").trim(); }
  if (!name || name.split(" ").length > MAX_NAME_WORDS) return null;
  c.name = name;

  groups.forEach((g, index) => {
    if (g.kind === "[" && index === 0) {
      // First bracket right after the name: a team roster when it has entries or nesting, else the person
      if (g.text.includes(";") || g.text.includes("[")) {
        c.isTeam = true;
        c.members = parseGcdCharacters(g.text);
      } else if (/^(un-?named|unidentified|various|several|some|other)\b/i.test(g.text)) {
        (c.notes ??= []).push(g.text); // "Atlanteans [unnamed ones]" describes the group, not a person
      } else if (g.text) {
        c.person = g.text;
      }
      return;
    }
    // Every other group holds notes: "(villain) (first full appearance)", "(villain, death)", "[statues]"
    for (const token of splitTopLevel(g.text, ",")) applyNote(c, token);
  });
  if (tail) (c.notes ??= []).push(tail);

  if (group) {
    c.group = group;
    c.role ??= roleFrom(group);
    if (/\bcameos?\b/.test(group)) c.cameo = true;
    if (/introduc|first appearance|debut/.test(group)) c.firstAppearance = true;
    if (/\b(deaths?|died|dies)\b/.test(group)) c.death = true;
  }
  return c;
}

/**
 * Parses a GCD story `characters` field into structured entries. Conventions seen in real data
 * (see __fixtures__/gcd): entries separated by ";", the person in brackets after the mantle, teams
 * as "Team [member; member [person]]", notes in parentheses — "(featured)", "(villain)",
 * "(antagonist)", "(guest)", "(supporting)", "(cameo)", "(flashback)", "(introduction)",
 * "(first full appearance)", "(death)", "(villain, death)", "(introduction, dies)" — and older
 * group labels ("Featuring: …; Villains: …; Guest stars: …"), which apply until the next label.
 */
export function parseGcdCharacters(text: string | null | undefined): GcdCharacter[] {
  if (!text) return [];
  const out: GcdCharacter[] = [];
  let group: string | undefined;
  for (let part of splitTopLevel(text)) {
    const label = part.match(LABEL);
    if (label && label[1].trim().split(/\s+/).length <= 4) {
      group = label[1].trim().toLowerCase();
      part = part.slice(label[0].length);
      if (!part.trim()) continue;
    }
    const entry = parseCharacterEntry(part, group);
    if (entry) out.push(entry);
  }
  return out;
}

/** Every character in a parsed list, team members included (teams themselves excluded). */
export function flattenGcdCharacters(list: GcdCharacter[]): GcdCharacter[] {
  return list.flatMap((c) => (c.isTeam ? flattenGcdCharacters(c.members ?? []) : [c]));
}
