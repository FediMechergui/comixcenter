/**
 * Contracts between the on-device engine's parts. The Android app runs the whole catalog on the
 * phone: it calls Metron, Comic Vine and the Grand Comics Database itself (through native HTTP,
 * since none of them allow browser CORS) and keeps everything in IndexedDB.
 *
 *   sources/   API clients (Metron, Comic Vine, GCD) built on HttpFn + Pacer + ResponseCache
 *   library/   comic file formats, embedded metadata, panel detection, PDF export, OPDS parsing
 *   (root)     database, sync jobs, catalog services and the /api router the UI talks to
 */

// ── HTTP ─────────────────────────────────────────────────────────────────────

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Query parameters; undefined values are dropped */
  params?: Record<string, string | number | boolean | undefined>;
  responseType?: "json" | "text" | "arraybuffer";
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  /** Header names lower-cased */
  headers: Record<string, string>;
  data: T;
}

/** Native HTTP in the app (CapacitorHttp), fetch in tests. Never throws on HTTP status codes. */
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** Persistent response cache (IndexedDB in the app, a Map in tests). */
export interface ResponseCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

// ── Errors every source client uses ──────────────────────────────────────────

/** The source refused for now (daily limit, or a 429 that outlasted our waiting). */
export class RateLimitError extends Error {
  constructor(message: string, public retryAfterSeconds: number) { super(message); this.name = "RateLimitError"; }
}

/** Credentials missing or rejected (HTTP 401/403). */
export class AuthError extends Error {
  constructor(message: string) { super(message); this.name = "AuthError"; }
}

/** Any other non-success answer from a source. */
export class SourceError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "SourceError"; }
}

export class NotFoundError extends SourceError {
  constructor(message: string) { super(message, 404); this.name = "NotFoundError"; }
}

// ── Library formats ──────────────────────────────────────────────────────────

export type ComicFormat = "cbz" | "cbr" | "cb7" | "pdf" | "epub";

export interface ComicPageData { data: Uint8Array; mime: string }

export interface EmbeddedFiles {
  comicinfo?: Uint8Array;   // ComicInfo.xml bytes
  metroninfo?: Uint8Array;  // MetronInfo.xml bytes
  pdfTitle?: string;
}

/** An opened comic file; pages are 0-based. */
export interface ComicSource {
  format: ComicFormat;
  pageCount: number;
  getPage(index: number): Promise<ComicPageData>;
  metadataFiles(): Promise<EmbeddedFiles>;
  close(): void;
}

/** Panel boxes as [x, y, w, h] fractions of the page, in reading order. */
export type PanelBox = [number, number, number, number];
