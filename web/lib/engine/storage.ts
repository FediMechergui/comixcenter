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

/** OPFS persists browser device-mode comics independently of the IndexedDB catalog. */
export function createBrowserStore(): FileStore {
  const urls = new Map<string, string>();
  async function parent(path: string, create = false) {
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("Invalid storage path");
    if (!navigator.storage?.getDirectory) throw new Error("This browser cannot store comics on this device. Use server mode or the Android app.");
    let dir = await navigator.storage.getDirectory();
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name: parts[parts.length - 1] };
  }
  function revoke(path: string) { const url = urls.get(path); if (url) { URL.revokeObjectURL(url); urls.delete(path); } }
  return {
    async write(path, data) {
      const { dir, name } = await parent(path, true);
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try { await writable.write(data as Uint8Array<ArrayBuffer>); await writable.close(); }
      catch (e) { await writable.abort().catch(() => {}); throw e; }
      revoke(path);
    },
    async read(path) { const { dir, name } = await parent(path); return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()); },
    async url(path) {
      const hit = urls.get(path); if (hit) return hit;
      const { dir, name } = await parent(path);
      const url = URL.createObjectURL(await (await dir.getFileHandle(name)).getFile());
      urls.set(path, url); return url;
    },
    async removeDir(path) {
      const { dir, name } = await parent(path);
      try { await dir.removeEntry(name, { recursive: true }); } catch (e) { if ((e as DOMException).name !== "NotFoundError") throw e; }
      for (const key of urls.keys()) if (key.startsWith(`${path}/`)) revoke(key);
    },
  };
}

export function fileStore(): FileStore {
  if (!store) {
    const native = typeof window !== "undefined" &&
      (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
    store = native ? createNativeStore() : createBrowserStore();
  }
  return store;
}

export function setFileStore(s: FileStore) { store = s; }
