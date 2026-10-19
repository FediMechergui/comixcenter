import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedCatalog, rememberCatalog } from "./catalog-cache";
import type { OpdsFeedPage } from "@/lib/types";
const data: OpdsFeedPage = { title: "Batcave", source: "batcave", entries: [{ title: "Example", author: "Batcave", kind: "publication", acquisitions: [], reader_url: "https://batcave.biz/12-example.html", href: null, cover: null, summary: null }], url: "https://batcave.biz/", next: null, previous: null, up: null };
afterEach(() => { localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("saved source listings", () => {
  it("keeps source, query and page separate and marks saved results", () => {
    rememberCatalog("batman:1", data);
    expect(cachedCatalog("batman:1")).toMatchObject({ source: "batcave", entries: data.entries, cached_at: expect.any(String) });
    expect(cachedCatalog("batman:2")).toBeUndefined();
  });
  it("expires after seven days and ignores damaged storage", () => {
    vi.useFakeTimers(); rememberCatalog("one", data); vi.advanceTimersByTime(7 * 86400_000);
    expect(cachedCatalog("one")).toBeUndefined();
    localStorage.setItem("comix.catalog-cache.v1", "invalid"); expect(cachedCatalog("one")).toBeUndefined();
  });
  it("bounds history and never replaces a useful page with an empty response", () => {
    for (let i = 0; i < 15; i++) rememberCatalog(String(i), data);
    expect(cachedCatalog("0")).toBeUndefined(); expect(cachedCatalog("14")).toBeDefined();
    rememberCatalog("14", { ...data, entries: [] }); expect(cachedCatalog("14")?.entries).toHaveLength(1);
  });
  it("does not break live browsing when storage is full", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota"); });
    expect(() => rememberCatalog("one", data)).not.toThrow();
  });
});
