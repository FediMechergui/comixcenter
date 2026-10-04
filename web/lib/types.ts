// Shapes returned by the ComixCenter API (backend/comix/services).

export type Tier = "essential" | "recommended" | "tie_in" | "optional" | "skip";
export type PathName = "essential" | "core" | "complete" | "all";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface Status {
  version: string;
  sources: { metron: boolean; comicvine: boolean };
  admin_protected: boolean;
  worker: { running: boolean; current_job_id: number | null; queued: number; failed: number };
  counts: Record<"series" | "issues" | "arcs" | "characters" | "teams" | "reading_orders" | "library_files", number>;
  scan_dirs: string[];
}

export interface PublisherCard {
  id: number; name: string; slug: string; image_url: string | null; series_count: number; universe_count: number;
}

export interface UniverseCard {
  id: number; name: string; slug: string; kind: string; designation: string | null; description: string | null;
  series_count: number; publisher: string | null;
}

export interface PublisherDetail extends Omit<PublisherCard, "series_count" | "universe_count"> {
  description: string | null; founded: number | null; country: string | null;
  universes: UniverseCard[]; cross_publisher_universes: UniverseCard[]; unclassified_series_count: number;
  imprints: { id: number; name: string }[];
}

export interface EraCard {
  id: number; name: string; slug: string; start_date: string; end_date: string | null; description: string | null;
  series_count: number;
}

export interface UniverseDetail extends UniverseCard {
  publisher_id: number | null; eras: EraCard[]; reading_orders: { id: number; name: string; era_id: number | null }[];
}

export interface SeriesCard {
  id: number; name: string; volume: number | null; year_began: number | null; year_end: number | null;
  issue_count: number | null; image_url: string | null; series_type: string | null; publisher: string | null;
}

export interface IssueCard {
  id: number; series_id: number; series_name: string; series_year: number | null; number: string;
  title: string | null; cover_date: string | null; image_url: string | null; read: boolean; owned: boolean;
}

export interface SeriesDetail extends SeriesCard {
  sort_name: string | null; status: string | null; description: string | null; publisher_id: number | null;
  imprint: string | null; first_cover_date: string | null; last_cover_date: string | null;
  metron_id: number | null; cv_id: number | null; synced_at: string | null;
  universes: { id: number; name: string; kind: string; source: string }[];
  eras: { id: number; name: string; universe_id: number }[];
  issues: IssueCard[]; read_count: number;
  arcs: { id: number; name: string; kind: string; issue_count: number }[];
  writers: { id: number; name: string; issues: number }[];
}

export interface LegalLink { service: string; kind: string; url: string }

export interface IssueDetail extends IssueCard {
  description: string | null; store_date: string | null; page_count: number | null; isbn: string | null;
  upc: string | null; metron_id: number | null; cv_id: number | null; deep_synced: boolean;
  series: SeriesCard; publisher_slug: string | null;
  credits: { role: string; creators: { id: number; name: string }[] }[];
  arcs: { id: number; name: string; kind: string; role: string; tier: Tier | null }[];
  characters: { identity_id: number; character_id: number; name: string; identity: string; image_url: string | null; role: string | null }[];
  teams: { id: number; name: string; image_url: string | null }[];
  universes: { id: number; name: string; kind: string }[];
  collected_in: IssueCard[]; collects: IssueCard[]; is_collection: boolean;
  files: { id: number; name: string; format: string; page_count: number; current_page: number }[];
  events: { kind: string; identity_id: number; character_id: number; name: string; note: string | null }[];
  reading_orders: { id: number; name: string; tier: Tier }[];
  previous_issue_id: number | null; next_issue_id: number | null; legal_links: LegalLink[];
}

export interface ArcSummary {
  id: number; name: string; kind: "arc" | "event"; image_url: string | null; issue_count: number; read_count: number;
  start_date: string | null; end_date: string | null;
}

export interface LinkedArc extends ArcSummary { note: string | null; source: string; link_id: number }

export interface ArcIssueCard extends IssueCard { role: "core" | "tie_in"; tier: Tier | null; position: number }

export interface ArcDetail extends ArcSummary {
  description: string | null; metron_id: number | null; cv_id: number | null;
  core_issues: ArcIssueCard[]; tie_ins: ArcIssueCard[];
  creators: { role: string; creators: { id: number; name: string; issues: number }[] }[];
  collected_editions: { issue_id: number; title: string; series_type: string | null; image_url: string | null; covers: number; of: number }[];
  prerequisites: LinkedArc[]; required_by: LinkedArc[]; leads_into: LinkedArc[]; follows: LinkedArc[];
  continues_in: ArcSummary[]; reading_orders: { id: number; name: string; tier: Tier }[];
}

export interface PlanStep extends ArcSummary { depth: number; done: boolean }

export interface Plan {
  target: ArcSummary; sequence: PlanStep[]; edges: { from: number; to: number; note: string | null }[];
  remaining_arcs: number; remaining_issues: number;
}

export interface PathProgress { issues: number; read: number }

export interface OrderCard {
  id: number; name: string; slug: string; kind: string; source: string; description: string | null;
  universe_id: number | null; era_id: number | null; character_id: number | null; team_id: number | null;
  arc_id: number | null; creator_id: number | null; updated_at: string;
  progress: { entries: number; paths: Record<PathName, PathProgress> };
}

export interface OrderEntry {
  id: number; position: number; tier: Tier; note: string | null; issue_count: number; read_count: number;
  type: "issue" | "arc"; issue?: IssueCard; arc?: { id: number; name: string; kind: string; image_url: string | null };
  issues?: IssueCard[]; prerequisites: { type: "arc" | "issue"; id: number; name: string | null }[]; done: boolean;
}

export interface OrderDetail extends OrderCard {
  path: PathName; tiers: Tier[]; entries: OrderEntry[]; next_entry_id: number | null; tier_counts: Record<Tier, number>;
}

export interface Progress { issues_read: number; recent: IssueCard[]; orders_in_progress: OrderCard[] }

export interface CharacterCard { id: number; name: string; image_url: string | null; appearances: number; identities: string[] }

export interface IssueRef { id: number | null; label: string; cover_date?: string | null; image_url?: string | null }

export interface IdentityDetail {
  id: number; name: string; display_name: string; real_name: string | null; aliases: string[]; description: string | null;
  image_url: string | null; appearances: number; first_seen: string | null; last_seen: string | null;
  first_appearance: IssueRef | null;
  events: { id: number; kind: string; note: string | null; source: string; issue: IssueRef | null; end_issue: IssueRef | null; image_url: string | null }[];
  metron_id: number | null; cv_id: number | null;
}

export interface CharacterDetail {
  id: number; name: string; description: string | null; image_url: string | null; publisher_id: number | null;
  identities: IdentityDetail[]; appearances: number;
  teams: { id: number; name: string; image_url: string | null; identity: string; since: string | null; until: string | null }[];
  universes: { id: number; name: string; issues: number }[];
  reading_orders: { id: number; name: string }[];
}

export interface Appearance extends IssueCard { role: string | null; identity: string; identity_id: number }

export interface TeamCard { id: number; name: string; image_url: string | null; appearances: number; members: number }

export interface RosterRow {
  id: number; identity_id: number; display_name: string; identity_name: string; character_id: number; character_name: string;
  image_url: string | null; source: string; note: string | null;
  from_issue_id: number | null; from_date: string | null; from_label: string | null;
  to_issue_id: number | null; to_date: string | null; to_label: string | null;
}

export interface TeamDetail {
  id: number; name: string; description: string | null; image_url: string | null; appearances: number;
  first_seen: string | null; last_seen: string | null; first_appearance: IssueRef | null; disbanded: string | null;
  roster: RosterRow[];
  members: { identity_id: number; character_id: number; name: string; identity: string; image_url: string | null }[];
  linked_teams: { team_id: number; name: string; image_url: string | null; kinds: string[]; note: string | null; shared_members: number }[];
  reading_orders: { id: number; name: string }[]; metron_id: number | null; cv_id: number | null;
}

export interface SearchHit { kind: string; id: number; title: string; subtitle: string; image_url: string | null; score: number }

export interface Candidate { issue_id: number; series_id: number; label: string; confidence: number; cover: string | null }

export interface LibraryFile {
  id: number; name: string; format: string; size: number; page_count: number; current_page: number; finished: boolean;
  added_at: string; last_read_at: string | null; managed: boolean; match_method: string | null;
  match_confidence: number | null; issue: IssueCard | null; candidates: Candidate[];
  parsed: { series?: string; number?: string; year?: number; volume?: string };
  comicinfo: Record<string, unknown>; cover_url: string;
}

export interface Job {
  id: number; kind: string; payload: Record<string, unknown>; status: "queued" | "running" | "done" | "failed";
  priority: number; attempts: number; error: string | null; result: Record<string, unknown> | null; progress: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; run_after: string | null;
}

export interface OpdsEntry {
  title: string; summary: string | null; author: string | null; cover: string | null;
  kind: "navigation" | "publication"; href: string | null; acquisitions: { href: string; type: string | null }[];
}

export interface OpdsFeedPage { title: string; entries: OpdsEntry[]; next: string | null; previous: string | null; up: string | null; url: string }
