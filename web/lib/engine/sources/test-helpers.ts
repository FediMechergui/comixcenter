/** Test-only helpers for the source clients (Node APIs allowed: never imported by runtime code). */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { HttpFn, HttpRequest, HttpResponse } from "../contracts";
import { buildUrl } from "./http";
import type { Clock } from "./http";

const FIXTURES = path.join(__dirname, "__fixtures__");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture(relPath: string): any {
  return JSON.parse(readFileSync(path.join(FIXTURES, relPath), "utf8"));
}

/** Virtual clock: `sleep` advances time instantly and records how long callers waited. */
export function fakeClock(start = 1_700_000_000_000): Clock & { sleeps: number[]; advance(ms: number): void } {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += Math.max(0, ms); await Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

export function respond(status: number, data: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, data, headers };
}

export interface MockCall { url: string; req: HttpRequest; at?: number }

/**
 * HttpFn backed by a router. `url` is the full URL (params included, in request order).
 * Unrouted requests answer 599 so a test fails loudly.
 */
export function mockHttp(route: (url: string, req: HttpRequest) => HttpResponse | undefined,
                         clock?: Clock): HttpFn & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fn = (async (req: HttpRequest) => {
    const url = buildUrl(req.url, req.params);
    calls.push({ url, req, at: clock?.now() });
    return route(url, req) ?? respond(599, { detail: `unrouted ${url}` });
  }) as HttpFn & { calls: MockCall[] };
  fn.calls = calls;
  return fn;
}
