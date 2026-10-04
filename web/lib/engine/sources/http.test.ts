import { describe, expect, it, vi } from "vitest";

import { RateLimitError } from "../contracts";
import {
  base64Utf8, buildUrl, cachedGet, cacheKey, createFetchHttp, createNativeHttp, MemoryCache, NetworkError, Pacer,
  pacedRequest, parseRetryAfter,
} from "./http";
import { fakeClock, mockHttp, respond } from "./test-helpers";

const capacitorRequest = vi.hoisted(() => vi.fn());
vi.mock("@capacitor/core", () => ({ CapacitorHttp: { request: capacitorRequest } }));

describe("buildUrl / cacheKey", () => {
  it("appends params, drops undefined, keeps an existing query", () => {
    expect(buildUrl("https://x/api/", { name: "Spider Man", year: 1963, skip: undefined }))
      .toBe("https://x/api/?name=Spider%20Man&year=1963");
    expect(buildUrl("https://x/api/?page=2", { format: "json" })).toBe("https://x/api/?page=2&format=json");
    expect(buildUrl("https://x/api/")).toBe("https://x/api/");
  });

  it("sorts params and leaves credentials out of cache keys", () => {
    expect(cacheKey("https://cv/api/issue/4000-1/", { format: "json", api_key: "secret", a: 1 }, ["api_key"]))
      .toBe("https://cv/api/issue/4000-1/?a=1&format=json");
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("50", 0)).toBe(50);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
  });
});

describe("Pacer", () => {
  it("serialises concurrent callers with the minimum spacing", async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ name: "Test", minIntervalMs: 3000, clock });
    const starts: number[] = [];
    const order: number[] = [];
    let running = 0;
    const task = (n: number) => pacer.schedule(async () => {
      running++;
      expect(running).toBe(1); // never two at once
      starts.push(clock.now());
      await Promise.resolve();
      order.push(n);
      running--;
      return n;
    });
    const results = await Promise.all([task(1), task(2), task(3)]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(starts[1] - starts[0]).toBe(3000);
    expect(starts[2] - starts[1]).toBe(3000);
  });

  it("keeps going after a failing task", async () => {
    const pacer = new Pacer({ name: "Test", minIntervalMs: 10, clock: fakeClock() });
    const failed = pacer.schedule(async () => { throw new Error("boom"); });
    const next = pacer.schedule(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("waits out a short gate and refuses a long one", async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ name: "Test", minIntervalMs: 0, clock, maxWaitMs: 65_000 });
    pacer.blockFor(20_000);
    const t0 = clock.now();
    await pacer.schedule(async () => undefined);
    expect(clock.now() - t0).toBe(20_000);

    pacer.blockFor(3_600_000);
    const err = await pacer.schedule(async () => "never").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(3600);
    expect(err.message).toContain("Test");
  });
});

describe("pacedRequest", () => {
  it("waits Retry-After and retries once on a short 429", async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ name: "Src", minIntervalMs: 1000, clock });
    let n = 0;
    const http = mockHttp(() => (++n === 1 ? respond(429, {}, { "retry-after": "50" }) : respond(200, { ok: true })), clock);
    const res = await pacedRequest(http, pacer, { url: "https://src/x" });
    expect(res.status).toBe(200);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1].at! - http.calls[0].at!).toBe(50_000);
  });

  it("throws RateLimitError when the 429 outlasts our patience, and blocks later callers", async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ name: "Src", minIntervalMs: 1000, clock });
    const http = mockHttp(() => respond(429, { detail: "Request was throttled. Expected available in 2895 seconds." }), clock);
    const err = await pacedRequest(http, pacer, { url: "https://src/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(2895); // no Retry-After header: read from DRF's message
    const again = await pacedRequest(http, pacer, { url: "https://src/y" }).catch((e) => e);
    expect(again).toBeInstanceOf(RateLimitError);
    expect(http.calls).toHaveLength(1); // the gate refused without touching the network
  });

  it("gives up after a second 429", async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ name: "Src", minIntervalMs: 0, clock });
    const http = mockHttp(() => respond(429, {}, { "retry-after": "5" }), clock);
    await expect(pacedRequest(http, pacer, { url: "https://src/x" })).rejects.toBeInstanceOf(RateLimitError);
    expect(http.calls).toHaveLength(2);
  });
});

describe("cachedGet / MemoryCache", () => {
  it("serves hits, stores misses, skips null and expires", async () => {
    const clock = fakeClock();
    const cache = new MemoryCache(clock);
    const load = vi.fn(async () => ({ v: 1 }));
    expect(await cachedGet(cache, "k", 60, load)).toEqual({ v: 1 });
    expect(await cachedGet(cache, "k", 60, load)).toEqual({ v: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    clock.advance(61_000);
    await cachedGet(cache, "k", 60, load);
    expect(load).toHaveBeenCalledTimes(2);
    await cachedGet(cache, "n", 60, async () => null);
    expect(await cache.get("n")).toBeUndefined();
  });

  it("survives a broken cache", async () => {
    const broken = { get: async () => { throw new Error("idb"); }, set: async () => { throw new Error("idb"); } };
    expect(await cachedGet(broken, "k", 60, async () => 5)).toBe(5);
  });
});

describe("createNativeHttp", () => {
  it("builds the URL, lower-cases headers and parses string JSON", async () => {
    capacitorRequest.mockResolvedValueOnce({ status: 200, headers: { "Content-Type": "text/plain", "Retry-After": "3" },
                                             data: '{"a":1}', url: "" });
    const http = createNativeHttp();
    const res = await http({ url: "https://h/api/", params: { q: "a b" }, headers: { Accept: "application/json" }, timeoutMs: 5000 });
    expect(capacitorRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      url: "https://h/api/?q=a%20b", method: "GET", responseType: "json", connectTimeout: 5000, readTimeout: 5000,
      headers: { Accept: "application/json" },
    }));
    expect(res).toEqual({ status: 200, headers: { "content-type": "text/plain", "retry-after": "3" }, data: { a: 1 } });
  });

  it("decodes base64 bodies for arraybuffer and keeps error statuses", async () => {
    capacitorRequest.mockResolvedValueOnce({ status: 404, headers: {}, data: btoa("\x01\x02\x03"), url: "" });
    const res = await createNativeHttp()({ url: "https://h/img", responseType: "arraybuffer" });
    expect(res.status).toBe(404);
    expect([...new Uint8Array(res.data as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it("throws NetworkError when the native call fails", async () => {
    capacitorRequest.mockRejectedValueOnce(new Error("Unable to resolve host"));
    await expect(createNativeHttp()({ url: "https://h/" })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("createFetchHttp", () => {
  it("returns status, lower-case headers and parsed JSON without throwing on 500", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"detail":"oops"}', { status: 500, headers: { "X-Test": "1" } }));
    const res = await createFetchHttp(fetchImpl as unknown as typeof fetch)({ url: "https://h/", params: { a: 1 } });
    expect(fetchImpl).toHaveBeenCalledWith("https://h/?a=1", expect.objectContaining({ method: "GET" }));
    expect(res.status).toBe(500);
    expect(res.headers["x-test"]).toBe("1");
    expect(res.data).toEqual({ detail: "oops" });
  });

  it("returns HTML as text when JSON was expected, and wraps network errors", async () => {
    const html = vi.fn(async () => new Response("<html>challenge</html>", { status: 403 }));
    expect((await createFetchHttp(html as unknown as typeof fetch)({ url: "https://h/" })).data).toBe("<html>challenge</html>");
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(createFetchHttp(down as unknown as typeof fetch)({ url: "https://h/" })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("base64Utf8", () => {
  it("encodes non-Latin-1 credentials", () => {
    expect(base64Utf8("user:pass")).toBe("dXNlcjpwYXNz");
    expect(atob(base64Utf8("é:ü"))).toBe("\xc3\xa9:\xc3\xbc");
  });
});
