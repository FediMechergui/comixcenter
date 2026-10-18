"use client";
// API client: server address, fetch helpers, SWR hooks.
import useSWR, { mutate as globalMutate, type SWRConfiguration } from "swr";

const SERVER_KEY = "comix.server";
const TOKEN_KEY = "comix.adminToken";
const MODE_KEY = "comix.mode";

export type DataMode = "device" | "server";

function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

/** Where the ComixCenter server lives, unless the person set one in Settings. */
export function defaultServer(): string {
  if (typeof window === "undefined") return "";
  // The Android emulator reaches the host machine at 10.0.2.2
  if (isNativeApp()) return "http://10.0.2.2:8000";
  const { origin, port } = window.location;
  // `next dev` on :3000 talks to the API on :8000; when the API serves the app, same origin
  return port === "3000" ? origin.replace(":3000", ":8000") : origin;
}

function readStore(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStore(key: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch { /* private mode: settings last for this session only */ }
}

export function serverUrl(): string {
  if (typeof window === "undefined") return "";
  return (readStore(SERVER_KEY) || defaultServer()).replace(/\/+$/, "");
}

export function setServerUrl(url: string | null) { writeStore(SERVER_KEY, url ? url.trim() : null); }

/**
 * Where the catalog lives. The Android app runs everything on the phone ("device") and calls
 * Metron, Comic Vine and the GCD itself; a browser talks to a ComixCenter server.
 */
export function dataMode(): DataMode {
  if (typeof window === "undefined") return "server";
  const saved = readStore(MODE_KEY);
  if (saved === "device" || saved === "server") return saved;
  return isNativeApp() ? "device" : "server";
}

export function setDataMode(mode: DataMode | null) { writeStore(MODE_KEY, mode); }
export function adminToken(): string | null { return typeof window === "undefined" ? null : readStore(TOKEN_KEY); }
export function setAdminToken(token: string | null) { writeStore(TOKEN_KEY, token); }

/** Absolute URL for API paths (images, downloads) */
export function apiUrl(path: string): string {
  // Already absolute: covers from Metron/GCD, and comic pages stored on the phone
  if (/^(https?:|blob:|data:|memory:|capacitor:)/i.test(path)) return path;
  return `${serverUrl()}${path}`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const TIMEOUT_MS = 10_000;          // a server that vanished from the Wi-Fi shouldn't hang the app
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

let jobListener = false;

/** On the phone: the engine answers, and screens refresh as background syncs finish. */
async function deviceRequest<T>(path: string, init: RequestInit): Promise<T> {
  const engine = await import("@/lib/engine");
  if (!jobListener) {
    jobListener = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    engine.onJobFinished(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; globalMutate((key) => typeof key === "string" && !key.startsWith("/api/online")); }, 1500);
    });
  }
  const body = init.body instanceof FormData ? init.body : typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  try {
    return (await engine.engineRequest(init.method ?? "GET", path, body)) as T;
  } catch (e) {
    if (e instanceof engine.HttpError) throw new ApiError(e.status, e.message);
    throw new ApiError(500, (e as Error).message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (dataMode() === "device") return deviceRequest<T>(path, init);
  const headers = new Headers(init.headers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.body instanceof FormData ? UPLOAD_TIMEOUT_MS : path.startsWith("/api/online/") ? 120_000 : TIMEOUT_MS);
  const token = adminToken();
  if (token) headers.set("X-Admin-Token", token);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let resp: Response;
  try {
    resp = await fetch(apiUrl(path), { ...init, headers, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    // Offline: comics saved for offline reading keep their details in the cache
    if (!init.method || init.method === "GET") {
      const { cachedJson } = await import("@/lib/offline");
      const cached = await cachedJson<T>(apiUrl(path));
      if (cached !== undefined) return cached;
    }
    throw new ApiError(0, `Can't reach the ComixCenter server at ${serverUrl() || "this address"}. Check the address in Settings and that the server is running.`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = typeof body.detail === "string" ? body.detail
        : Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join("; ") : detail;
    } catch { /* not JSON */ }
    throw new ApiError(resp.status, detail || `Request failed (${resp.status})`);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  put: <T,>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T,>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};

/**
 * Screens are revisited constantly (tab bar, back, breadcrumbs) and most of them ask for data
 * that has not moved. SWR's two-second window was short enough that every return trip re-ran the
 * query; a sync finishing still refreshes everything through `refresh`, which bypasses this.
 */
const DEDUPE_MS = 30_000;

export function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(path, (p: string) => api.get<T>(p), { revalidateOnFocus: false, dedupingInterval: DEDUPE_MS, ...config });
}

/** Refetch every cached query whose path starts with one of the prefixes. */
export function refresh(...prefixes: string[]) {
  return globalMutate((key) => typeof key === "string" && prefixes.some((p) => key.startsWith(p)));
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
