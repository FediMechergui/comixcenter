/**
 * The phone's catalog database (IndexedDB via Dexie). Mirrors backend/comix/models.py so the
 * services port line by line. Every searchable record keeps a `words` multi-entry index of
 * lowercase tokens; search intersects prefix matches on it.
 */
import Dexie, { type Table } from "dexie";

export type Id = number;
export type Source = "metron" | "comicvine" | "gcd" | "rule" | "derived" | "curated" | "generated" | "starter";
export type Tier = "essential" | "recommended" | "tie_in" | "optional" | "skip";
export type UniverseKind = "continuity" | "alternate" | "line" | "standalone" | "intercompany";

export interface Publisher {
  id?: Id; name: string; slug: string; metron_id?: number | null; cv_id?: number | null; gcd_id?: number | null;
  founded?: number | null; country?: string | null; description?: string | null; image_url?: string | null;
  sort_order: number;
}
export interface Imprint { id?: Id; publisher_id?: Id | null; name: string; metron_id?: number | null }
export interface Universe {
  id?: Id; publisher_id?: Id | null; name: string; slug: string; designation?: string | null; kind: UniverseKind;
  description?: string | null; metron_id?: number | null; sort_order: number;
}
export interface Era {
  id?: Id; universe_id: Id; name: string; slug: string; start_date: string; end_date?: string | null;
  description?: string | null;
}
export interface Series {
  id?: Id; publisher_id?: Id | null; imprint_id?: Id | null; name: string; sort_name?: string | null;
  volume?: number | null; year_began?: number | null; year_end?: number | null; series_type?: string | null;
  status?: string | null; description?: string | null; image_url?: string | null; issue_count?: number | null;
  first_cover_date?: string | null; last_cover_date?: string | null;
  metron_id?: number | null; cv_id?: number | null; gcd_id?: number | null;
  synced_at?: string | null; words: string[];
}
export interface SeriesUniverse { series_id: Id; universe_id: Id; source: Source }
export interface Issue {
  id?: Id; series_id: Id; number: string; number_sort: number; title?: string | null;
  cover_date?: string | null; store_date?: string | null; description?: string | null; image_url?: string | null;
  page_count?: number | null; isbn?: string | null; upc?: string | null;
  metron_id?: number | null; cv_id?: number | null; gcd_id?: number | null;
  synced_at?: string | null; deep_synced_at?: string | null; cv_enriched_at?: string | null;
  genres?: string[] | null; words: string[];
}
export interface IssueUniverse { issue_id: Id; universe_id: Id }
export interface Creator { id?: Id; name: string; metron_id?: number | null; cv_id?: number | null; words: string[] }
export interface Credit { id?: Id; issue_id: Id; creator_id: Id; role: string }
export interface CollectedIssue { collection_issue_id: Id; issue_id: Id }
export interface Arc {
  id?: Id; name: string; kind: "arc" | "event"; description?: string | null; image_url?: string | null;
  publisher_id?: Id | null; metron_id?: number | null; cv_id?: number | null; synced_at?: string | null; words: string[];
}
export interface ArcIssue { arc_id: Id; issue_id: Id; position: number; role: "core" | "tie_in"; tier?: Tier | null }
export interface ArcLink {
  id?: Id; arc_id: Id; target_arc_id: Id; kind: "prerequisite" | "leads_into"; note?: string | null; source: Source;
}
export interface Character {
  id?: Id; name: string; description?: string | null; image_url?: string | null; publisher_id?: Id | null; words: string[];
}
export interface Identity {
  id?: Id; character_id: Id; name: string; display_name: string; real_name?: string | null; aliases?: string[] | null;
  description?: string | null; image_url?: string | null; publisher_id?: Id | null;
  first_appearance_issue_id?: Id | null; first_appearance_text?: string | null;
  metron_id?: number | null; cv_id?: number | null; gcd_key?: string | null;
  synced_at?: string | null; cv_enriched_at?: string | null; words: string[];
}
export type AppearanceRole = "main" | "supporting" | "cameo";
export interface Appearance { issue_id: Id; identity_id: Id; role?: AppearanceRole | null; role_source: Source }
export interface CharacterEvent {
  id?: Id; identity_id: Id; kind: "first_appearance" | "death" | "resurrection" | "costume";
  issue_id?: Id | null; issue_text?: string | null; end_issue_id?: Id | null; cv_issue_id?: number | null;
  note?: string | null; image_url?: string | null; source: Source;
}
export interface Team {
  id?: Id; name: string; description?: string | null; image_url?: string | null; publisher_id?: Id | null;
  first_appearance_issue_id?: Id | null; first_appearance_text?: string | null; disbanded_text?: string | null;
  metron_id?: number | null; cv_id?: number | null; gcd_key?: string | null;
  synced_at?: string | null; cv_enriched_at?: string | null; words: string[];
}
export interface TeamAppearance { issue_id: Id; team_id: Id }
export interface TeamAffiliation { identity_id: Id; team_id: Id; source: Source }
export interface Membership {
  id?: Id; team_id: Id; identity_id: Id; from_issue_id?: Id | null; to_issue_id?: Id | null; note?: string | null; source: Source;
}
export interface TeamLink { id?: Id; team_id: Id; other_team_id: Id; kind: "spinoff" | "related" | "successor"; note?: string | null; source: Source }
export type OrderKind = "universe" | "character" | "team" | "event" | "writer" | "custom";
export interface ReadingOrder {
  id?: Id; name: string; slug: string; kind: OrderKind; description?: string | null;
  universe_id?: Id | null; era_id?: Id | null; character_id?: Id | null; team_id?: Id | null; arc_id?: Id | null;
  creator_id?: Id | null; source: Source; metron_reading_list_id?: number | null;
  created_at: string; updated_at: string; words: string[];
}
export interface Entry {
  id?: Id; order_id: Id; position: number; issue_id?: Id | null; arc_id?: Id | null; tier: Tier; note?: string | null;
}
export interface EntryPrereq { id?: Id; entry_id: Id; requires_issue_id?: Id | null; requires_arc_id?: Id | null; note?: string | null }
export interface ReadStatus { issue_id: Id; read_at: string }
export interface LibraryFile {
  id?: Id; dir: string; original_name: string; format: string; size: number; sha256: string; page_count: number;
  added_at: string; issue_id?: Id | null; match_method?: string | null; match_confidence?: number | null;
  comicinfo?: Record<string, unknown> | null; parsed?: Record<string, unknown> | null;
  current_page: number; finished_at?: string | null; last_read_at?: string | null; opds_feed_id?: Id | null;
  page_ext: string[];   // file extension of each stored page image, by index
}
export interface PagePanels { file_id: Id; page_index: number; width: number; height: number; panels: number[][] }
export interface OpdsFeed { id?: Id; name: string; url: string; username?: string | null; password?: string | null; created_at: string }
export type JobStatus = "queued" | "running" | "done" | "failed";
export interface Job {
  id?: Id; kind: string; payload: Record<string, unknown>; dedupe_key: string; status: JobStatus; priority: number;
  attempts: number; error?: string | null; result?: Record<string, unknown> | null; progress?: string | null;
  run_after?: string | null; created_at: string; started_at?: string | null; finished_at?: string | null;
}
export interface HttpCacheRow { key: string; value: unknown; expires: number }
export interface Setting { key: string; value: unknown }

export class ComixDB extends Dexie {
  publishers!: Table<Publisher, Id>;
  imprints!: Table<Imprint, Id>;
  universes!: Table<Universe, Id>;
  eras!: Table<Era, Id>;
  series!: Table<Series, Id>;
  seriesUniverses!: Table<SeriesUniverse, [Id, Id]>;
  issues!: Table<Issue, Id>;
  issueUniverses!: Table<IssueUniverse, [Id, Id]>;
  creators!: Table<Creator, Id>;
  credits!: Table<Credit, Id>;
  collected!: Table<CollectedIssue, [Id, Id]>;
  arcs!: Table<Arc, Id>;
  arcIssues!: Table<ArcIssue, [Id, Id]>;
  arcLinks!: Table<ArcLink, Id>;
  characters!: Table<Character, Id>;
  identities!: Table<Identity, Id>;
  appearances!: Table<Appearance, [Id, Id]>;
  characterEvents!: Table<CharacterEvent, Id>;
  teams!: Table<Team, Id>;
  teamAppearances!: Table<TeamAppearance, [Id, Id]>;
  teamAffiliations!: Table<TeamAffiliation, [Id, Id]>;
  memberships!: Table<Membership, Id>;
  teamLinks!: Table<TeamLink, Id>;
  readingOrders!: Table<ReadingOrder, Id>;
  entries!: Table<Entry, Id>;
  entryPrereqs!: Table<EntryPrereq, Id>;
  readStatus!: Table<ReadStatus, Id>;
  libraryFiles!: Table<LibraryFile, Id>;
  pagePanels!: Table<PagePanels, [Id, number]>;
  opdsFeeds!: Table<OpdsFeed, Id>;
  jobs!: Table<Job, Id>;
  httpCache!: Table<HttpCacheRow, string>;
  settings!: Table<Setting, string>;

  constructor(name = "comixcenter") {
    super(name);
    this.version(1).stores({
      publishers: "++id, &slug, metron_id, gcd_id, cv_id, name",
      imprints: "++id, publisher_id, metron_id",
      universes: "++id, &slug, publisher_id, metron_id",
      eras: "++id, universe_id",
      series: "++id, publisher_id, metron_id, gcd_id, cv_id, name, year_began, *words",
      seriesUniverses: "[series_id+universe_id], series_id, universe_id",
      issues: "++id, series_id, metron_id, gcd_id, cv_id, upc, isbn, cover_date, *words",
      issueUniverses: "[issue_id+universe_id], issue_id, universe_id",
      creators: "++id, metron_id, cv_id, name, *words",
      credits: "++id, issue_id, creator_id, [issue_id+creator_id+role]",
      collected: "[collection_issue_id+issue_id], collection_issue_id, issue_id",
      arcs: "++id, metron_id, cv_id, name, publisher_id, *words",
      arcIssues: "[arc_id+issue_id], arc_id, issue_id",
      arcLinks: "++id, arc_id, target_arc_id, [arc_id+target_arc_id+kind]",
      characters: "++id, name, publisher_id, *words",
      identities: "++id, character_id, metron_id, cv_id, gcd_key, *words",
      appearances: "[issue_id+identity_id], issue_id, identity_id",
      characterEvents: "++id, identity_id, issue_id, cv_issue_id",
      teams: "++id, metron_id, cv_id, gcd_key, name, *words",
      teamAppearances: "[issue_id+team_id], issue_id, team_id",
      teamAffiliations: "[identity_id+team_id], identity_id, team_id",
      memberships: "++id, team_id, identity_id",
      teamLinks: "++id, team_id, other_team_id",
      readingOrders: "++id, &slug, kind, universe_id, character_id, team_id, arc_id, creator_id, metron_reading_list_id, *words",
      entries: "++id, order_id, issue_id, arc_id",
      entryPrereqs: "++id, entry_id",
      readStatus: "issue_id, read_at",
      libraryFiles: "++id, &sha256, issue_id, added_at, last_read_at",
      pagePanels: "[file_id+page_index], file_id",
      opdsFeeds: "++id",
      jobs: "++id, status, dedupe_key, [status+priority]",
      httpCache: "key, expires",
      settings: "key",
    });
  }
}

let current: ComixDB | null = null;

export function db(): ComixDB {
  if (!current) current = new ComixDB();
  return current;
}

/** Tests use a fresh database per case. */
export function useDatabase(instance: ComixDB): ComixDB {
  current = instance;
  return instance;
}

export const nowIso = () => new Date().toISOString();

/** All tables, for transactions that touch everything (sync, imports). */
export function allTables(d: ComixDB = db()) {
  return d.tables;
}
