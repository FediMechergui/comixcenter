import { afterEach, describe, expect, it, vi } from "vitest";
import { onlineCatalog } from "./catalog";
import { withDeadline } from "./http";
import { rememberCatalog } from "./catalog-cache";

const mocks = vi.hoisted(() => ({ batcave: vi.fn(), getcomics: vi.fn(), gateway: vi.fn() }));
vi.mock("./batcave", () => ({ batcaveCatalog: mocks.batcave }));
vi.mock("./getcomics", () => ({ GETCOMICS_SCHEME: "getcomics://", fetchGetComicsOpds: mocks.getcomics }));
vi.mock("@/lib/gateway", () => ({ gatewayUrl: () => "https://gateway.test", gatewayRequest: mocks.gateway }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); localStorage.clear(); });

describe("phone-only source discovery", () => {
  it("returns an explicitly marked saved page when every source fails", async () => {
    rememberCatalog(JSON.stringify(["batcave", "Batman", 1]), { title: "Batcave", source: "batcave", entries: [{ title: "Saved" }], next: null, previous: null, up: null, url: "https://batcave.biz/" } as never);
    mocks.gateway.mockRejectedValue(new Error("blocked")); mocks.batcave.mockRejectedValue(new Error("blocked"));
    expect(await onlineCatalog("Batman", 1, "batcave")).toMatchObject({ cached_at: expect.any(String), entries: [{ title: "Saved" }] });
    expect(mocks.getcomics).not.toHaveBeenCalled();
  });
  it("uses a working hosted source without waiting for a stuck native bridge", async () => {
    mocks.batcave.mockReturnValue(new Promise(() => {}));
    mocks.getcomics.mockRejectedValue(new Error("blocked"));
    mocks.gateway.mockResolvedValue({ title: "GetComics", entries: [{ title: "A comic" }], source: "getcomics" });
    vi.useFakeTimers();
    expect((await onlineCatalog()).source).toBe("getcomics");
    await vi.runAllTimersAsync();
  });
  it("bounds a native promise that never settles", async () => {
    vi.useFakeTimers();
    const request = withDeadline(new Promise(() => {}), 12000);
    const assertion = expect(request).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
  });
  it("does not call Batcave when GetComics is explicitly selected", async () => {
    mocks.getcomics.mockResolvedValue({ title: "GetComics", entries: [] });
    mocks.gateway.mockRejectedValue(new Error("offline"));
    await onlineCatalog("Batman", 2, "getcomics");
    expect(mocks.batcave).not.toHaveBeenCalled();
    expect(mocks.getcomics.mock.calls[0][0]).toContain("q=Batman");
  });
});
