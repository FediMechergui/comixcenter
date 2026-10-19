/**
 * API clients built from the credentials saved on the phone. GCD needs none (an optional account
 * raises its rate limit); Metron and Comic Vine use the person's own account. Clients are rebuilt when credentials change.
 */
import type { HttpFn, ResponseCache } from "./contracts";
import { db } from "./db";
import type { ComicVineApi } from "./sync/comicvine";
import type { GcdApi } from "./sync/gcd";
import type { MetronApi } from "./sync/metron";
import * as sources from "./sources";
import { gatewayUrl, gatewayRequest } from "@/lib/gateway";

export class NotConfiguredError extends Error {
  constructor(message: string) { super(message); this.name = "NotConfiguredError"; }
}

export interface Credentials {
  hosted_metron?: boolean;
  hosted_comicvine?: boolean;
  metron_token?: string | null;
  metron_username?: string | null;
  metron_password?: string | null;
  comicvine_key?: string | null;
  gcd_username?: string | null;
  gcd_password?: string | null;
}

const CRED_KEY = "credentials";
type CredentialKey = Exclude<keyof Credentials, "hosted_metron" | "hosted_comicvine">;

/** Distributed builds contain catalog data, never shared account passwords or API keys. */
export const BUILT_IN_CREDENTIALS: Credentials = {};

let builtIn: Credentials = BUILT_IN_CREDENTIALS;
/** Explicit injection for tests and local tooling. Never sourced from NEXT_PUBLIC variables. */
export function setBuiltInCredentials(c: Credentials) { builtIn = c; reset(); }

/** Only what was entered in Settings on this phone. */
export async function getSavedCredentials(): Promise<Credentials> {
  return ((await db().settings.get(CRED_KEY))?.value as Credentials) ?? {};
}

/** Settings first, then the built-in accounts. */
export async function getCredentials(): Promise<Credentials> {
  const saved = await getSavedCredentials();
  const merged: Credentials = { ...saved };
  // A saved Metron token or username replaces the whole built-in Metron sign-in, and likewise for GCD
  const groups: CredentialKey[][] = [["gcd_username", "gcd_password"], ["comicvine_key"], ["metron_token", "metron_username", "metron_password"]];
  for (const keys of groups) {
    if (keys.some((k) => saved[k])) continue;
    for (const k of keys) if (builtIn[k]) merged[k] = builtIn[k];
  }
  const url = gatewayUrl();
  if (url) {
    if (!hostedState || hostedState.url !== url || hostedState.expires < Date.now()) {
      if (!hostedPromise) hostedPromise = gatewayRequest<{ metadata?: { metron?: boolean; comicvine?: boolean } }>("/api/status", 1500)
        .then((s) => { hostedState = { url, expires: Date.now() + 120_000, metron: !!s.metadata?.metron, comicvine: !!s.metadata?.comicvine }; })
        .catch(() => { hostedState = { url, expires: Date.now() + 10_000, metron: false, comicvine: false }; })
        .finally(() => { hostedPromise = null; });
      await hostedPromise;
    }
    merged.hosted_metron = hostedState?.metron || false;
    merged.hosted_comicvine = hostedState?.comicvine || false;
  }
  return merged;
}

let hostedState: { url: string; expires: number; metron: boolean; comicvine: boolean } | null = null;
let hostedPromise: Promise<void> | null = null;

export async function saveCredentials(creds: Credentials): Promise<void> {
  const clean: Credentials = {};
  for (const [k, v] of Object.entries(creds)) if (typeof v === "string" && v.trim()) clean[k as CredentialKey] = v.trim();
  await db().settings.put({ key: CRED_KEY, value: clean });
  reset();
}

export function metronConfigured(c: Credentials) { return !!(c.metron_token || (c.metron_username && c.metron_password) || c.hosted_metron); }
export function comicvineConfigured(c: Credentials) { return !!(c.comicvine_key || c.hosted_comicvine); }
export function gcdAccountConfigured(c: Credentials) { return !!(c.gcd_username && c.gcd_password); }

/** HTTP responses cached in IndexedDB (keyed by URL, never including credentials). */
export const idbCache: ResponseCache = {
  async get(key) {
    const row = await db().httpCache.get(key);
    if (!row) return undefined;
    if (row.expires < Date.now()) { await db().httpCache.delete(key); return undefined; }
    return row.value;
  },
  async set(key, value, ttlSeconds) {
    await db().httpCache.put({ key, value, expires: Date.now() + ttlSeconds * 1000 });
  },
};

let http: HttpFn | null = null;
let metron: MetronApi | null = null;
let comicvine: ComicVineApi | null = null;
let gcd: GcdApi | null = null;

/** Tests and the desktop dev server inject their own transport. */
export function setHttp(fn: HttpFn | null) { http = fn; reset(); }

export function transport(): HttpFn {
  if (!http) http = sources.createNativeHttp();
  return http;
}

export function reset() { metron = comicvine = gcd = null; }

/** Never send device account headers to the hosted gateway; it uses its own server credentials. */
function hostedMetadata(source: "metron" | "comicvine" | "gcd"): HttpFn {
  return async (request) => {
    const url = new URL(request.url);
    const resource = url.pathname.replace(/^\/api\//, "");
    const query = new URLSearchParams(url.search);
    for (const [key, value] of Object.entries(request.params || {})) if (value !== undefined) query.set(key, String(value));
    query.delete("api_key");
    const data = await gatewayRequest(`/api/upstream/${source}/${resource}?${query}`, 12_000);
    return { status: 200, headers: {}, data };
  };
}

export async function getMetron(): Promise<MetronApi> {
  if (metron) return metron;
  const c = await getCredentials();
  if (!(c.metron_token || (c.metron_username && c.metron_password))) {
    if (!c.hosted_metron) throw new NotConfiguredError("Add your Metron account in Settings, or check the hosted gateway connection.");
    metron = sources.createMetronClient({ http: hostedMetadata("metron"), auth: { token: "gateway-managed" }, cache: idbCache }) as unknown as MetronApi;
    return metron;
  }
  const auth = c.metron_token ? { token: c.metron_token } : { username: c.metron_username!, password: c.metron_password! };
  metron = sources.createMetronClient({ http: transport(), auth, cache: idbCache }) as unknown as MetronApi;
  return metron;
}

export async function getComicVine(): Promise<ComicVineApi> {
  if (comicvine) return comicvine;
  const c = await getCredentials();
  if (!c.comicvine_key) {
    if (!c.hosted_comicvine) throw new NotConfiguredError("Add your Comic Vine API key in Settings, or check the hosted gateway connection.");
    comicvine = sources.createComicVineClient({ http: hostedMetadata("comicvine"), apiKey: "gateway-managed", cache: idbCache }) as unknown as ComicVineApi;
    return comicvine;
  }
  comicvine = sources.createComicVineClient({ http: transport(), apiKey: c.comicvine_key!, cache: idbCache }) as unknown as ComicVineApi;
  return comicvine;
}

/** GCD works without an account; with one, requests count against that account's own limit. */
export async function getGcd(): Promise<GcdApi> {
  if (gcd) return gcd;
  const c = await getCredentials();
  const auth = gcdAccountConfigured(c) ? { username: c.gcd_username!, password: c.gcd_password! } : null;
  gcd = sources.createGcdClient({ http: transport(), cache: idbCache, auth }) as unknown as GcdApi;
  return gcd;
}

/** Test injection of fake clients. */
export function setClients(c: { metron?: MetronApi | null; comicvine?: ComicVineApi | null; gcd?: GcdApi | null }) {
  if ("metron" in c) metron = c.metron ?? null;
  if ("comicvine" in c) comicvine = c.comicvine ?? null;
  if ("gcd" in c) gcd = c.gcd ?? null;
}
