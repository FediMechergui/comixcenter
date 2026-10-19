import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export class DownloadCancelled extends Error { constructor() { super("Download cancelled"); this.name = "DownloadCancelled"; } }
export interface TransferProgress { received: number; total?: number }
export interface DownloadOptions { signal?: AbortSignal; onProgress?: (p: TransferProgress) => void; onImportProgress?: (done: number, total: number) => void }
interface NativeTransfer {
  start(options: { id: string; url: string; authorization?: string }): Promise<{ uri: string; received: number }>;
  cancel(options: { id: string }): Promise<void>;
  discard(options: { id: string }): Promise<void>;
  recover(): Promise<void>;
  addListener(event: "progress", callback: (p: TransferProgress & { id: string }) => void): Promise<PluginListenerHandle>;
}
const native = registerPlugin<NativeTransfer>("ComicDownload");
export async function recoverDownloadFiles() { if (Capacitor.isNativePlatform()) await native.recover(); }
export function checkCancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DownloadCancelled(); }

export function downloadAddress(value: string): URL {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use a direct HTTP or HTTPS comic file address");
  return url;
}

/** The native transfer only returns a private file URI; bytes are read through the local file server. */
async function nativeBytes(url: string, headers: Record<string,string>, options: DownloadOptions): Promise<Uint8Array> {
  const id = crypto.randomUUID();
  const listener = await native.addListener("progress", (p) => { if (p.id === id) options.onProgress?.({ received: p.received, total: p.total }); });
  const cancel = () => { void native.cancel({ id }).catch(() => {}); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    checkCancelled(options.signal);
    const file = await native.start({ id, url, authorization: headers.Authorization });
    checkCancelled(options.signal);
    const response = await fetch(Capacitor.convertFileSrc(file.uri), { signal: options.signal });
    if (!response.ok) throw new Error("The temporary comic file could not be read");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("That comic exceeds the 64 MB import limit");
    return bytes;
  } catch (error) {
    if (options.signal?.aborted) throw new DownloadCancelled();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await listener.remove().catch(() => {});
    await native.discard({ id }).catch(() => {});
  }
}

/** Browser device-mode uses a bounded stream. The Android app uses disk streaming instead. */
export async function browserBytes(url: string, headers: Record<string,string>, options: DownloadOptions): Promise<Uint8Array> {
  const controller = new AbortController();
  let expired = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { expired = true; controller.abort(); }, 120_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    checkCancelled(options.signal);
    // Fetch strips authorization on cross-origin redirects; no credentialed cookies are requested.
    const response = await fetch(url, { headers, signal: controller.signal, credentials: "omit" });
    if (!response.ok) throw new Error(`The download source answered HTTP ${response.status}`);
    if (response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error("The source returned a web page instead of a comic file");
    const length = response.headers.get("content-length");
    const expected = length === null ? undefined : Number(length);
    const total = expected !== undefined && Number.isFinite(expected) && expected >= 0 ? expected : undefined;
    if (total !== undefined && total > MAX_DOWNLOAD_BYTES) throw new Error("That comic exceeds the 64 MB import limit");
    if (!response.body) throw new Error("This browser cannot stream the comic file");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let received = 0;
    options.onProgress?.({ received, total });
    while (true) {
      checkCancelled(options.signal);
      const chunk = await reader.read(); if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) throw new Error("That comic exceeds the 64 MB import limit");
      chunks.push(chunk.value); options.onProgress?.({ received, total });
    }
    if (!received || (total !== undefined && total !== received)) throw new Error("The download was empty or interrupted. Retry the source");
    const result = new Uint8Array(received); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw new DownloadCancelled();
    if (expired) throw new Error("The download exceeded its two-minute limit");
    throw error;
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    options.signal?.removeEventListener("abort", cancel); clearTimeout(timer);
  }
}

export async function downloadBytes(url: string, headers: Record<string,string> = {}, options: DownloadOptions = {}) {
  downloadAddress(url); checkCancelled(options.signal);
  return Capacitor.isNativePlatform() ? nativeBytes(url, headers, options) : browserBytes(url, headers, options);
}
