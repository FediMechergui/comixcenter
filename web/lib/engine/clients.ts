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

export class NotConfiguredError extends Error {
  constructor(message: string) { super(message); this.name = "NotConfiguredError"; }
}

export interface Credentials {
  metron_token?: string | null;
  metron_username?: string | null;
  metron_password?: string | null;
  comicvine_key?: string | null;
  gcd_username?: string | null;
  gcd_password?: string | null;
}

const CRED_KEY = "credentials";

/** Accounts built into this copy of the app (web/.env.local at build time); Settings override them. */
export const BUILT_IN_CREDENTIALS: Credentials = {
  gcd_username: process.env.NEXT_PUBLIC_GCD_USERNAME || null,
  gcd_password: process.env.NEXT_PUBLIC_GCD_PASSWORD || null,
  comicvine_key: process.env.NEXT_PUBLIC_COMICVINE_KEY || null,
  metron_token: process.env.NEXT_PUBLIC_METRON_TOKEN || null,
  metron_username: process.env.NEXT_PUBLIC_METRON_USERNAME || null,
  metron_password: process.env.NEXT_PUBLIC_METRON_PASSWORD || null,
};

let builtIn: Credentials = BUILT_IN_CREDENTIALS;
/** Tests run without the built-in accounts. */
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
  const groups: (keyof Credentials)[][] = [["gcd_username", "gcd_password"], ["comicvine_key"], ["metron_token", "metron_username", "metron_password"]];
  for (const keys of groups) {
    if (keys.some((k) => saved[k])) continue;
    for (const k of keys) if (builtIn[k]) merged[k] = builtIn[k];
  }
  return merged;
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  const clean: Credentials = {};
  for (const [k, v] of Object.entries(creds)) if (typeof v === "string" && v.trim()) clean[k as keyof Credentials] = v.trim();
  await db().settings.put({ key: CRED_KEY, value: clean });
  reset();
}

export function metronConfigured(c: Credentials) { return !!(c.metron_token || (c.metron_username && c.metron_password)); }
export function comicvineConfigured(c: Credentials) { return !!c.comicvine_key; }
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

export async function getMetron(): Promise<MetronApi> {
  if (metron) return metron;
  const c = await getCredentials();
  if (!metronConfigured(c)) throw new NotConfiguredError("Add your Metron account in Settings to use Metron.");
  const auth = c.metron_token ? { token: c.metron_token } : { username: c.metron_username!, password: c.metron_password! };
  metron = sources.createMetronClient({ http: transport(), auth, cache: idbCache }) as unknown as MetronApi;
  return metron;
}

export async function getComicVine(): Promise<ComicVineApi> {
  if (comicvine) return comicvine;
  const c = await getCredentials();
  if (!comicvineConfigured(c)) throw new NotConfiguredError("Add your Comic Vine API key in Settings to use Comic Vine.");
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
