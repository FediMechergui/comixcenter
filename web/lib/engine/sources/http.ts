/**
 * HTTP plumbing shared by the source clients: native/fetch HttpFn implementations, a per-source
 * Pacer (serialised requests + rate-limit gate), 429 handling and response-cache helpers.
 *
 * Runs in the Android WebView: no Node APIs here (atob/btoa/TextEncoder/AbortController only).
 */
import { CapacitorHttp } from "@capacitor/core";

import { RateLimitError } from "../contracts";
import type { HttpFn, HttpRequest, HttpResponse, ResponseCache } from "../contracts";

/** One User-Agent for every source (GCD asks API users to identify themselves). */
export const USER_AGENT = "ComixCenter/0.1 (personal comic reader app)";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Native bridges can fail to settle even after their own socket timeout. Bound the JS wait too. */
export async function withDeadline<T>(operation: Promise<T>, ms: number, message = "The source took too long. Try another source."): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new NetworkError(message)), ms);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** The request never got an HTTP answer (offline, DNS, TLS, timeout). */
export class NetworkError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = "NetworkError"; }
}

// ── URLs ─────────────────────────────────────────────────────────────────────

type Params = HttpRequest["params"];

/** `url` plus query params (undefined dropped), appended after any query the URL already has. */
export function buildUrl(url: string, params?: Params, opts: { sort?: boolean; omit?: string[] } = {}): string {
  if (!params) return url;
  let keys = Object.keys(params).filter((k) => params[k] !== undefined && !opts.omit?.includes(k));
  if (opts.sort) keys = keys.sort();
  if (!keys.length) return url;
  const query = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join("&");
  return url + (url.includes("?") ? "&" : "?") + query;
}

/** Stable cache key: full URL with sorted params, credentials (e.g. `api_key`) left out. */
export function cacheKey(url: string, params?: Params, omit: string[] = []): string {
  return buildUrl(url, params, { sort: true, omit });
}

// ── Response normalisation ───────────────────────────────────────────────────

function lowerHeaders(headers: Record<string, unknown> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    // Android's HttpURLConnection reports the status line under a null key
    if (!k || k === "null" || v == null) continue;
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function parseJsonLoose(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

// ── HttpFn implementations ───────────────────────────────────────────────────

/**
 * Native HTTP through CapacitorHttp (no CORS). The URL is built here so the native layer gets
 * the exact URL we also use as cache key. Android parses JSON itself only when the server says
 * `application/json` and returns base64 for binary bodies, so both are normalised here.
 */
export function createNativeHttp(): HttpFn {
  return async (req) => {
    const responseType = req.responseType ?? "json";
    const url = buildUrl(req.url, req.params);
    const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res;
    try {
      res = await withDeadline(CapacitorHttp.request({
        url,
        method: req.method ?? "GET",
        headers: req.headers ?? {},
        responseType,
        connectTimeout: timeout,
        readTimeout: timeout,
      }), timeout);
    } catch (err) {
      throw new NetworkError(`${req.method ?? "GET"} ${url} failed: ${(err as Error)?.message ?? err}`, err);
    }
    let data: unknown = res.data;
    if (responseType === "json" && typeof data === "string") data = data.trim() ? parseJsonLoose(data) : null;
    else if (responseType === "arraybuffer" && typeof data === "string") data = base64ToArrayBuffer(data);
    else if (responseType === "text" && data != null && typeof data !== "string") data = JSON.stringify(data);
    return { status: res.status, headers: lowerHeaders(res.headers), data };
  };
}

/** fetch-based HttpFn for desktop, dev and tests. JSON bodies that fail to parse come back as text. */
export function createFetchHttp(fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)): HttpFn {
  return async (req) => {
    const url = buildUrl(req.url, req.params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { method: req.method ?? "GET", headers: req.headers, signal: controller.signal });
      } catch (err) {
        throw new NetworkError(`${req.method ?? "GET"} ${url} failed: ${(err as Error)?.message ?? err}`, err);
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      let data: unknown;
      const type = req.responseType ?? "json";
      if (type === "arraybuffer") data = await res.arrayBuffer();
      else {
        const text = await res.text();
        data = type === "text" ? text : text.trim() ? parseJsonLoose(text) : null;
      }
      return { status: res.status, headers, data };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Pacing ───────────────────────────────────────────────────────────────────

/** Injectable time source so tests can run pacing logic on a virtual clock. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export interface PacerOptions {
  /** Shown in RateLimitError messages */
  name: string;
  /** Minimum time between the starts of two requests */
  minIntervalMs: number;
  /** A gate further away than this is refused with RateLimitError instead of waited out */
  maxWaitMs?: number;
  clock?: Clock;
}

/**
 * Serialises one source's requests: each task starts after the previous one finished, at least
 * `minIntervalMs` after the previous start, and not before the "blocked until" gate (set from
 * 429/Retry-After or exhausted rate-limit headers). Concurrent callers queue on a promise chain.
 */
export class Pacer {
  readonly name: string;
  readonly clock: Clock;
  minIntervalMs: number;
  maxWaitMs: number;
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = -Infinity;
  private blockedUntilMs = 0;

  constructor(opts: PacerOptions) {
    this.name = opts.name;
    this.minIntervalMs = opts.minIntervalMs;
    this.maxWaitMs = opts.maxWaitMs ?? 65_000;
    this.clock = opts.clock ?? realClock;
  }

  get blockedUntil(): number { return this.blockedUntilMs; }

  /** Nobody starts a request before `timeMs` (only ever extends the gate). */
  blockUntil(timeMs: number): void { this.blockedUntilMs = Math.max(this.blockedUntilMs, timeMs); }

  blockFor(ms: number): void { this.blockUntil(this.clock.now() + ms); }

  /** Seconds the gate is still closed, 0 when open. */
  blockedForSeconds(): number { return Math.max(0, (this.blockedUntilMs - this.clock.now()) / 1000); }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const now = this.clock.now();
      const gate = this.blockedUntilMs - now;
      if (gate > this.maxWaitMs) {
        const seconds = Math.ceil(gate / 1000);
        throw new RateLimitError(`${this.name} is rate limited; try again in ${formatSeconds(seconds)}`, seconds);
      }
      const wait = Math.max(gate, this.lastStart + this.minIntervalMs - now);
      if (wait > 0) await this.clock.sleep(wait);
      this.lastStart = this.clock.now();
      return task();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** Retry-After as seconds (delta-seconds or HTTP-date), undefined when absent/unparseable. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - nowMs) / 1000);
}

/** Django REST framework's throttle body (GCD, Metron): "Expected available in 2895 seconds." */
function throttledSeconds(body: unknown): number | undefined {
  const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : "";
  const m = detail.match(/available in (\d+(?:\.\d+)?) seconds?/i);
  return m ? Number(m[1]) : undefined;
}

export interface PacedRequestOptions {
  /** Statuses that mean "slow down" (default [429]; Comic Vine also uses 420) */
  rateLimitStatuses?: number[];
  /** Assumed Retry-After when the server sends none */
  defaultRetryAfterSeconds?: number;
  /** Close the pacer gate for everyone when a refusal outlasts our waiting (default true) */
  blockOnRefusal?: boolean;
  /** Sees every response, including refused ones (e.g. to read rate-limit headers) */
  onResponse?: (res: HttpResponse) => void;
}

/**
 * Sends `req` through `pacer`. On a rate-limit status: if Retry-After ≤ the pacer's max wait,
 * closes the gate for that long and retries once; otherwise (or on a second refusal) throws
 * RateLimitError. Other statuses are returned untouched for the client to map.
 */
export async function pacedRequest(http: HttpFn, pacer: Pacer, req: HttpRequest,
                                   opts: PacedRequestOptions = {}): Promise<HttpResponse> {
  const statuses = opts.rateLimitStatuses ?? [429];
  for (let attempt = 0; ; attempt++) {
    const res = await pacer.schedule(() => http(req));
    opts.onResponse?.(res);
    if (!statuses.includes(res.status)) return res;
    const retryAfter = parseRetryAfter(res.headers["retry-after"], pacer.clock.now())
      ?? throttledSeconds(res.data) ?? opts.defaultRetryAfterSeconds ?? 60;
    const waitable = retryAfter * 1000 <= pacer.maxWaitMs;
    if (waitable || opts.blockOnRefusal !== false) pacer.blockFor(retryAfter * 1000);
    if (attempt === 0 && waitable) continue;
    throw new RateLimitError(`${pacer.name} refused the request (HTTP ${res.status}); retry in ${formatSeconds(retryAfter)}`,
                             Math.ceil(retryAfter));
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * Returns the cached value for `key`, or loads, stores (when not null/undefined) and returns it.
 * Cache failures never fail the request: a broken IndexedDB just means more network traffic.
 */
export async function cachedGet<T>(cache: ResponseCache | undefined, key: string, ttlSeconds: number,
                                   load: () => Promise<T>): Promise<T> {
  if (cache && ttlSeconds > 0) {
    try {
      const hit = await cache.get(key);
      if (hit !== undefined) return hit as T;
    } catch { /* cache unavailable: fall through to the network */ }
  }
  const value = await load();
  if (cache && ttlSeconds > 0 && value !== undefined && value !== null) {
    try { await cache.set(key, value, ttlSeconds); } catch { /* best effort */ }
  }
  return value;
}

/** In-memory ResponseCache (tests, or a session-scoped cache on desktop). */
export class MemoryCache implements ResponseCache {
  private store = new Map<string, { value: unknown; expires: number }>();
  constructor(private clock: Pick<Clock, "now"> = realClock) {}
  async get(key: string): Promise<unknown | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.clock.now()) { this.store.delete(key); return undefined; }
    return hit.value;
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expires: this.clock.now() + ttlSeconds * 1000 });
  }
  get size(): number { return this.store.size; }
}

// ── Small shared helpers ─────────────────────────────────────────────────────

/** Result of the testMetron / testComicVine / testGcd credential checks */
export interface SourceTestResult { ok: boolean; message: string }

/** "user:pass" → base64 of its UTF-8 bytes (btoa alone only handles Latin-1). */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
