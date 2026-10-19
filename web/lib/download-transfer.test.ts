import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserBytes, downloadBytes, downloadAddress, DownloadCancelled, MAX_DOWNLOAD_BYTES } from "./download-transfer";

const bridge = vi.hoisted(() => ({ native: vi.fn(), start: vi.fn(), discard: vi.fn(), callback: (_p: { id: string; received: number; total?: number }) => {} }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: bridge.native, convertFileSrc: () => "http://localhost/temporary-comic" },
  registerPlugin: () => ({ start: bridge.start, cancel: vi.fn(), discard: bridge.discard, recover: vi.fn(), addListener: async (_event: string, callback: typeof bridge.callback) => { bridge.callback = callback; return { remove: vi.fn().mockResolvedValue(undefined) }; } }),
}));
beforeEach(() => { bridge.native.mockReturnValue(false); bridge.discard.mockResolvedValue(undefined); });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("keeps the native transfer id out of application progress updates", async () => {
  bridge.native.mockReturnValue(true);
  bridge.start.mockImplementation(async ({ id }) => { bridge.callback({ id, received: 3, total: 3 }); return { uri: "file://private/comic", received: 3 }; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]))));
  const progress = vi.fn(); await downloadBytes("https://source.test/comic", {}, { onProgress: progress });
  expect(progress).toHaveBeenCalledWith({ received: 3, total: 3 });
  expect(progress.mock.calls[0][0]).not.toHaveProperty("id");
  expect(bridge.discard).toHaveBeenCalled();
});
it.each(["file:///etc/passwd", "javascript:alert(1)", "https://user:password@source.test/comic"])("rejects unsupported address %s", (url) => {
  expect(() => downloadAddress(url)).toThrow();
});
it("streams a file and reports byte progress without requesting browser cookies", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]), { headers: { "content-length": "3" } }));
  vi.stubGlobal("fetch", fetch);
  const progress = vi.fn();
  expect(await browserBytes("https://source.test/comic", {}, { onProgress: progress })).toEqual(new Uint8Array([1,2,3]));
  expect(progress).toHaveBeenLastCalledWith({ received: 3, total: 3 });
  expect(fetch.mock.calls[0][1].credentials).toBe("omit");
});
it("reports progress for an unknown content length", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2]))));
  const progress = vi.fn();
  await browserBytes("https://source.test/comic", {}, { onProgress: progress });
  expect(progress).toHaveBeenLastCalledWith({ received: 2, total: undefined });
});
it("rejects oversized declared lengths before reading a body", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { headers: { "content-length": String(MAX_DOWNLOAD_BYTES+1) } })));
  await expect(browserBytes("https://source.test/comic", {}, {})).rejects.toThrow("64 MB");
});
it("enforces the byte limit even when the source omits content length", async () => {
  const chunk = new Uint8Array(16*1024*1024);
  const stream = new ReadableStream({ start(c) { for (let i=0;i<5;i++) c.enqueue(chunk); c.close(); } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
  await expect(browserBytes("https://source.test/comic", {}, {})).rejects.toThrow("64 MB");
});
it("rejects an HTML verification page instead of importing it", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Verify", { headers: { "content-type": "text/html" } })));
  await expect(browserBytes("https://source.test/comic", {}, {})).rejects.toThrow("web page");
});
it("detects a truncated transfer", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-length": "20" } })));
  await expect(browserBytes("https://source.test/comic", {}, {})).rejects.toThrow("interrupted");
});
it("cancels the stream and leaves no completed bytes", async () => {
  const cancel = vi.fn(); const signal = new AbortController();
  const stream = new ReadableStream({ cancel });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
  await expect(browserBytes("https://source.test/comic", {}, { signal: signal.signal, onProgress: () => signal.abort() })).rejects.toBeInstanceOf(DownloadCancelled);
  expect(cancel).toHaveBeenCalled();
});
