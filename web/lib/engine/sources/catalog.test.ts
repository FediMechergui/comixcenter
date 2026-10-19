import { afterEach, describe, expect, it, vi } from "vitest";
import { onlineCatalog } from "./catalog";
import { withDeadline } from "./http";

const mocks = vi.hoisted(() => ({ batcave: vi.fn(), getcomics: vi.fn(), gateway: vi.fn() }));
vi.mock("./batcave", () => ({ batcaveCatalog: mocks.batcave }));
vi.mock("./getcomics", () => ({ GETCOMICS_SCHEME: "getcomics://", fetchGetComicsOpds: mocks.getcomics }));
vi.mock("@/lib/gateway", () => ({ gatewayUrl: () => "https://gateway.test", gatewayRequest: mocks.gateway }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("phone-only source discovery", () => {
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
