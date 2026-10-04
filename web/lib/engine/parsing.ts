/**
 * Title parsing and fuzzy matching (port of backend/comix/parsing.py and the RapidFuzz scorer
 * the backend uses), shared by library matching, sync and search.
 */

const PUBLISHER_KEYWORDS: Record<string, string[]> = {
  marvel: ["marvel", "avengers", "spider-man", "spiderman", "x-men", "x-force", "daredevil", "thor", "iron man", "hulk", "wolverine", "venom", "fantastic four", "captain america"],
  dc: ["dc comics", "jla", "jsa", "batman", "superman", "wonder woman", "flash", "green lantern", "justice league", "aquaman", "harley quinn", "nightwing", "shazam", "catwoman", "robin", "titans", "swamp thing"],
  image: ["image comics", "spawn", "saga", "invincible", "monstress", "walking dead", "radiant black", "witchblade"],
  "dark horse": ["dark horse", "hellboy", "b.p.r.d.", "sin city", "aliens", "predator", "black hammer"],
  idw: ["idw", "tmnt", "teenage mutant ninja turtles", "transformers", "sonic the hedgehog", "locke & key"],
  boom: ["boom! studios", "boom studios", "power rangers", "something is killing the children", "brzrkr"],
  dynamite: ["dynamite", "the boys", "red sonja", "vampirella"],
};

export const PUBLISHER_DISPLAY_NAMES: Record<string, string> = {
  marvel: "Marvel", dc: "DC", image: "Image", "dark horse": "Dark Horse", idw: "IDW", boom: "BOOM!", dynamite: "Dynamite",
};

// Phrases that contain a publisher keyword but belong to nobody in particular
const KEYWORD_EXCLUSIONS = ["robin hood"];

// "#1", "#001", "#1.5", "#1.MU", "#1 – 3", "#1-#5"
const ISSUE_RE = /#\s*(\d+(?:\.\d+)?(?:\.[A-Za-z]+)?)(?:\s*[-–]\s*#?\s*(\d+(?:\.\d+)?))?/;
const ISSUE_RE_G = new RegExp(ISSUE_RE.source, "g");
// "Abominations 1 - 3 (2025)": a bare range right before the year or at the end
const BARE_RANGE_RE = /(?<![\d(])\b(\d{1,4})\s*[-–]\s*(\d{1,4})\s*(?=\(|$)/;
const BARE_RANGE_RE_G = new RegExp(BARE_RANGE_RE.source, "g");
// "(2026)", "(2024-)", "(2024-2025)", "(2024 - )"
const YEAR_RE = /\((\d{4})(?:\s*[-–]\s*(?:\d{4})?)?\s*\)/;
const VOLUME_RE = /(?:\bVol\.?|\bVolume)\s*(\d+)/i;
const VOLUME_RE_G = /(?:\bVol\.?|\bVolume)\s*(\d+)/gi;
const RELEASE_TAG_RE_G = /\s*\([^)]*(?:TPB|Omnibus|Digital|Webrip|Empire|Kileko)[^)]*\)/gi;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function cleanHtml(raw: string): string {
  return unescapeHtml(raw.replace(/<[^>]+>/g, "")).trim();
}

/** Multi-paragraph text from HTML descriptions (Comic Vine), keeping paragraph breaks. */
export function stripHtml(text: string | null | undefined): string | null {
  if (!text) return null;
  let cleaned = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  cleaned = cleaned.replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>/gi, "\n");
  cleaned = unescapeHtml(cleaned.replace(/<[^>]+>/g, ""));
  cleaned = cleaned.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return cleaned || null;
}

/** Canonical issue form so "001", "1" and "01" compare equal; ranges become "1-3". */
export function normalizeIssueNumber(issue: string | null | undefined): string | null {
  if (!issue) return null;
  return issue.trim().split(/\s*[-–]\s*/).map((part) => {
    const m = /^0*(\d+)(.*)$/.exec(part);
    return m ? `${m[1]}${m[2]}` : part;
  }).join("-");
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Whole-word match, so "thor" doesn't hit "Thorgal" and "flash" doesn't hit "Flashpoint"
export function keywordIn(keyword: string, text: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRe(keyword)}(?![a-z0-9])`).test(text);
}

export function detectPublisher(titleLower: string, categoryName?: string | null): string {
  if (categoryName) {
    const cat = categoryName.toLowerCase();
    for (const key of ["marvel", "dc", "image", "dark horse"]) if (keywordIn(key, cat)) return PUBLISHER_DISPLAY_NAMES[key];
  }
  let text = titleLower;
  for (const phrase of KEYWORD_EXCLUSIONS) text = text.split(phrase).join(" ");
  for (const [pub, keywords] of Object.entries(PUBLISHER_KEYWORDS)) {
    if (keywords.some((k) => keywordIn(k, text))) return PUBLISHER_DISPLAY_NAMES[pub];
  }
  return "Independent";
}

export interface ParsedTitle {
  title: string; clean_title: string; series_name: string; issue_number: string | null;
  volume: string | null; year: number | null; format: string; publisher: string;
}

export function parseComicTitle(rawTitle: string, categoryName?: string | null): ParsedTitle {
  const title = cleanHtml(rawTitle);
  const lower = title.toLowerCase();
  const yearMatch = YEAR_RE.exec(title);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
  const volMatch = VOLUME_RE.exec(title);
  const volume = volMatch ? volMatch[1] : null;

  let issue: string | null = null;
  const issueMatch = ISSUE_RE.exec(title);
  if (issueMatch) {
    issue = issueMatch[2] ? `${issueMatch[1]}-${issueMatch[2]}` : issueMatch[1];
  } else {
    const named = /\b(?:Issue|Chapter)\s*(\d+)/i.exec(title);
    const bare = BARE_RANGE_RE.exec(title);
    if (named) issue = named[1];
    else if (bare) issue = `${bare[1]}-${bare[2]}`;
  }
  issue = normalizeIssueNumber(issue);

  // "Vol." alone only means a collection when there's no issue number
  let format = "Issue";
  if (lower.includes("weekly pack") || lower.includes("week pack")) format = "Weekly Pack";
  else if (lower.includes("omnibus")) format = "Omnibus";
  else if (lower.includes("tpb") || lower.includes("trade paperback") || (volume && !issue)) format = "TPB";
  else if (keywordIn("annual", lower)) format = "Annual";

  let clean = title.replace(/\s*\(\d{4}.*?\)/g, "");
  clean = clean.replace(RELEASE_TAG_RE_G, "");
  clean = clean.replace(ISSUE_RE_G, "");
  if (!issueMatch) clean = clean.replace(BARE_RANGE_RE_G, "");
  clean = clean.replace(VOLUME_RE_G, "");
  clean = clean.replace(/\s{2,}/g, " ").replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, "");

  return {
    title, clean_title: clean || title, series_name: clean || title, issue_number: issue,
    volume, year, format, publisher: detectPublisher(lower, categoryName),
  };
}

// ── Fuzzy matching (RapidFuzz-compatible token_sort_ratio) ──

/** RapidFuzz default_process: lowercase, non-alphanumerics to spaces, trimmed. */
export function defaultProcess(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Normalized Indel similarity 0..100, as RapidFuzz `ratio`. */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 100;
  return (100 * 2 * lcsLength(a, b)) / total;
}

export function tokenSortRatio(a: string, b: string): number {
  const sort = (s: string) => defaultProcess(s).split(/\s+/).filter(Boolean).sort().join(" ");
  return ratio(sort(a), sort(b));
}

/** "Astérix" → "asterix", so searches match with or without accents. */
export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

/** Lowercase, accent-folded search tokens for the IndexedDB word indexes. */
export function words(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of defaultProcess(foldAccents(t)).split(/\s+/)) if (w) out.add(w);
  }
  return [...out];
}

// ── Issue numbers and character names ──

const FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75 };

/** Sortable value for issue numbers: "1" < "1.MU" < "2", "½" = 0.5, non-numeric last. */
export function numberSort(number: string | null | undefined): number {
  if (!number) return 1e9;
  const text = number.trim();
  for (const [f, v] of Object.entries(FRACTIONS)) if (text.startsWith(f)) return v;
  const m = /-?\d+(?:\.\d+)?/.exec(text);
  if (!m) return 1e9;
  const value = parseFloat(m[0]);
  return value + (text.slice(m.index + m[0].length).trim() ? 0.001 : 0);
}

/**
 * "Spider-Man (Miles Morales)" → ["Spider-Man", "Miles Morales"]; "Thor" → ["Thor", "Thor"].
 * Parentheses holding an earth/universe tag stay on the mantle: "Thor (Earth-1610)".
 */
export function splitMantle(name: string): [string, string] {
  const m = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(name.trim());
  if (m && !/\b(earth|universe|\d{3,})/i.test(m[2])) return [m[1].trim(), m[2].trim()];
  return [name.trim(), name.trim()];
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function norm(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
