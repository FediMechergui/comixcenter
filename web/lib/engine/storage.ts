/**
 * Where imported comics live on the phone. Pages are written once at import into the app's
 * private storage and shown straight from there (Capacitor serves them to the WebView), so
 * reading needs no decoding and works offline.
 */
export interface FileStore {
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  /** URL an <img> or fetch() in the WebView can load */
  url(path: string): Promise<string>;
  removeDir(path: string): Promise<void>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Capacitor Filesystem in the app's data directory. */
export function createNativeStore(): FileStore {
  const fs = () => import("@capacitor/filesystem");
  const uriCache = new Map<string, string>();
  return {
    async write(path, data) {
      const { Filesystem, Directory } = await fs();
      await Filesystem.writeFile({ path, data: toBase64(data), directory: Directory.Data, recursive: true });
    },
    async read(path) {
      const { Filesystem, Directory } = await fs();
      const r = await Filesystem.readFile({ path, directory: Directory.Data });
      return typeof r.data === "string" ? fromBase64(r.data) : new Uint8Array(await (r.data as Blob).arrayBuffer());
    },
    async url(path) {
      const hit = uriCache.get(path);
      if (hit) return hit;
      const [{ Filesystem, Directory }, { Capacitor }] = await Promise.all([fs(), import("@capacitor/core")]);
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
      const url = Capacitor.convertFileSrc(uri);
      uriCache.set(path, url);
      return url;
    },
    async removeDir(path) {
      const { Filesystem, Directory } = await fs();
      try { await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true }); } catch { /* already gone */ }
      for (const k of uriCache.keys()) if (k.startsWith(path)) uriCache.delete(k);
    },
  };
}

/** In-memory store for tests and browsers without Capacitor. */
export function createMemoryStore(): FileStore {
  const files = new Map<string, Uint8Array>();
  return {
    async write(path, data) { files.set(path, data.slice()); },
    async read(path) {
      const f = files.get(path);
      if (!f) throw new Error(`No such file: ${path}`);
      return f;
    },
    async url(path) { return `memory://${path}`; },
    async removeDir(path) { for (const k of [...files.keys()]) if (k.startsWith(`${path}/`)) files.delete(k); },
  };
}

let store: FileStore | null = null;

export function fileStore(): FileStore {
  if (!store) {
    const native = typeof window !== "undefined" &&
      (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
    store = native ? createNativeStore() : createMemoryStore();
  }
  return store;
}

export function setFileStore(s: FileStore) { store = s; }
