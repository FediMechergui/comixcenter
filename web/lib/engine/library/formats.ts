/**
 * One page-oriented interface over the comic formats people own: CBZ, CBR, CB7, PDF and EPUB
 * (port of archives.py), running entirely on the phone.
 *
 * CBZ and EPUB are read in place: only the central directory is parsed at open and each page is
 * inflated on demand. CBR / CB7 are solid archives (slow to seek), so their page images are
 * extracted once at open with WebAssembly builds of unrar and 7-Zip, and the wasm instance is
 * dropped afterwards. PDF pages are rendered to JPEG with pdf.js on request.
 */
import { unzipSync } from "fflate";
import type { SevenZipModuleFactory } from "7z-wasm";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ComicFormat, ComicPageData, ComicSource, EmbeddedFiles } from "../contracts";
import { canvasToBytes, makeCanvas, releaseCanvas } from "./canvas";
import { isPageImage, mimeFor, naturalCompare } from "./imaging";
import { descendants, localName, parseXml, children } from "./xml";

/** Where the app serves the engine's static assets (copied by scripts/copy-engine-assets.mjs). */
export const DEFAULT_UNRAR_WASM_URL = "/wasm/unrar.wasm";
export const DEFAULT_SEVEN_ZIP_WASM_URL = "/wasm/7zz.wasm";
/**
 * 7z-wasm's ES module, loaded at runtime instead of bundled: both of its builds reference Node
 * built-ins ("module", "fs") behind runtime checks, and Turbopack fails the build on those.
 */
export const DEFAULT_SEVEN_ZIP_JS_URL = "/wasm/7zz.es6.js";
export const DEFAULT_PDF_WORKER_URL = "/pdf.worker.min.mjs";

export const PDF_TARGET_LONG_SIDE = 2000;
export const PDF_JPEG_QUALITY = 0.88;

export const SUPPORTED_EXTENSIONS = [".cbz", ".cbr", ".cb7", ".pdf", ".epub", ".zip", ".rar", ".7z"] as const;

export class ArchiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArchiveError";
  }
}

/** The pdf.js build the engine uses: the legacy build carries the polyfills Chromium 124 needs. */
export type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** Renders one pdf.js page to an encoded image; the default draws on a canvas and encodes JPEG. */
export type PdfPageRenderer = (page: PDFPageProxy) => Promise<ComicPageData>;

export interface OpenOptions {
  /** Skip magic-byte detection when the caller already knows the format. */
  format?: ComicFormat;
  /** unrar.wasm location (default DEFAULT_UNRAR_WASM_URL), or its bytes (tests in Node pass bytes). */
  unrarWasmUrl?: string;
  unrarWasm?: ArrayBuffer | Uint8Array;
  /** 7zz.wasm location (default DEFAULT_SEVEN_ZIP_WASM_URL), or its bytes. */
  sevenZipWasmUrl?: string;
  sevenZipWasm?: ArrayBuffer | Uint8Array;
  /** 7z-wasm's ES module location (default DEFAULT_SEVEN_ZIP_JS_URL), or its factory (tests pass the npm package). */
  sevenZipJsUrl?: string;
  loadSevenZip?: () => Promise<SevenZipModuleFactory>;
  /** pdf.js worker script; null leaves GlobalWorkerOptions alone (Node uses pdf.js's fake worker). */
  pdfWorkerUrl?: string | null;
  /**
   * pdf.js transfers its input to the worker, detaching it. By default it gets a copy so the
   * caller's bytes stay usable; true skips the copy when the caller is done with them.
   */
  transferPdfBytes?: boolean;
  /** Override how PDF pages become images (e.g. a native renderer); defaults to canvas + JPEG. */
  renderPdfPage?: PdfPageRenderer;
}

/** The asset URLs above as openComic options. */
export const DEFAULT_ASSET_URLS = {
  unrarWasmUrl: DEFAULT_UNRAR_WASM_URL,
  sevenZipWasmUrl: DEFAULT_SEVEN_ZIP_WASM_URL,
  sevenZipJsUrl: DEFAULT_SEVEN_ZIP_JS_URL,
  pdfWorkerUrl: DEFAULT_PDF_WORKER_URL,
} as const satisfies OpenOptions;

let defaults: OpenOptions = {};

/** App start-up: options every later openComic call starts from (DEFAULT_ASSET_URLS plus overrides). */
export function configureLibrary(options: OpenOptions = {}): void {
  defaults = { ...DEFAULT_ASSET_URLS, ...options };
}

/** Comic as opened by the engine; `pageNames` are archive paths in page order (empty for PDF). */
export interface LibraryComic extends ComicSource {
  pageNames: readonly string[];
}

// ── detection ────────────────────────────────────────────────────────────────

function hasPrefix(bytes: Uint8Array, sig: number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

const MAGIC_PDF = [0x25, 0x50, 0x44, 0x46];                     // %PDF
const MAGIC_RAR = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];         // Rar!\x1a\x07 (RAR4 and RAR5)
const MAGIC_7Z = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const MAGIC_ZIP = [0x50, 0x4b];                                 // PK

/** cbz / cbr / cb7 / pdf / epub from the magic bytes (extensions lie: many .cbr are zips). */
export function detectFormat(bytes: Uint8Array): ComicFormat {
  if (hasPrefix(bytes, MAGIC_PDF)) return "pdf";
  if (hasPrefix(bytes, MAGIC_RAR)) return "cbr";
  if (hasPrefix(bytes, MAGIC_7Z)) return "cb7";
  if (hasPrefix(bytes, MAGIC_ZIP)) {
    const zip = new ZipIndex(bytes);
    if (zip.has("mimetype") && latin1(zip.read("mimetype")).trim() === "application/epub+zip") return "epub";
    if (zip.has("META-INF/container.xml") && zip.names.some((n) => n.endsWith(".opf"))) return "epub";
    return "cbz";
  }
  throw new ArchiveError("Unsupported or unrecognised file format");
}

function latin1(data: Uint8Array): string {
  return new TextDecoder("latin1").decode(data);
}

// ── ZIP (CBZ / EPUB) ─────────────────────────────────────────────────────────

/**
 * Entry names from the central directory; entries are inflated one at a time on request.
 * fflate re-reads the central directory per lookup, which costs microseconds next to inflating a page.
 */
class ZipIndex {
  readonly names: string[] = [];
  private readonly set: Set<string>;

  constructor(private readonly bytes: Uint8Array) {
    try {
      unzipSync(bytes, { filter: (f) => { this.names.push(f.name); return false; } });
    } catch (e) {
      throw new ArchiveError(`Corrupt zip archive: ${(e as Error).message}`, { cause: e });
    }
    this.set = new Set(this.names);
  }

  has(name: string): boolean {
    return this.set.has(name);
  }

  read(name: string): Uint8Array {
    let out: Uint8Array | undefined;
    try {
      out = unzipSync(this.bytes, { filter: (f) => f.name === name })[name];
    } catch (e) {
      throw new ArchiveError(`Could not read ${name}: ${(e as Error).message}`, { cause: e });
    }
    if (!out) throw new ArchiveError(`Missing archive entry ${name}`);
    return out;
  }
}

const METADATA_NAMES = { "comicinfo.xml": "comicinfo", "metroninfo.xml": "metroninfo" } as const;

function metadataKey(path: string): "comicinfo" | "metroninfo" | undefined {
  const base = path.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  return METADATA_NAMES[base as keyof typeof METADATA_NAMES];
}

function checkIndex(index: number, count: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`page ${index} out of range (0..${count - 1})`);
  }
}

function zipComic(format: "cbz" | "epub", zip: ZipIndex, pageNames: string[]): LibraryComic {
  return {
    format,
    pageNames,
    pageCount: pageNames.length,
    async getPage(index) {
      checkIndex(index, pageNames.length);
      const data = zip.read(pageNames[index]);
      return { data, mime: mimeFor(data) };
    },
    async metadataFiles() {
      const found: EmbeddedFiles = {};
      for (const name of zip.names) {
        const key = metadataKey(name);
        if (key) found[key] = zip.read(name);
      }
      return found;
    },
    close() {},
  };
}

function sortedPageImages(names: Iterable<string>): string[] {
  return [...names].filter(isPageImage).sort(naturalCompare);
}

// posixpath.normpath / join / dirname, enough for archive-internal hrefs.
function normpath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + (out.join("/") || (path.startsWith("/") ? "" : "."));
}

function joinPath(base: string, href: string): string {
  return normpath(href.startsWith("/") || !base ? href : `${base}/${href}`);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function unquote(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Comic EPUBs: one image per spine document, in spine order (empty when the package can't be read). */
function epubSpineImages(zip: ZipIndex): string[] {
  let rootfile: string | null | undefined;
  let opf: Document | null = null;
  try {
    const container = parseXml(zip.read("META-INF/container.xml"));
    rootfile = container && descendants(container.documentElement).find((e) => localName(e) === "rootfile")
      ?.getAttribute("full-path");
    if (rootfile) opf = parseXml(zip.read(rootfile));
  } catch {
    return [];
  }
  if (!rootfile || !opf) return [];
  const base = dirname(rootfile);
  const all = descendants(opf.documentElement);
  const manifest = new Map<string, Element>();
  for (const m of all.filter((e) => localName(e) === "manifest")) {
    for (const item of children(m, "item")) {
      const id = item.getAttribute("id");
      if (id !== null) manifest.set(id, item);
    }
  }
  const images: string[] = [];
  for (const spine of all.filter((e) => localName(e) === "spine")) {
    for (const ref of children(spine, "itemref")) {
      const item = manifest.get(ref.getAttribute("idref") ?? "");
      if (!item) continue;
      const href = joinPath(base, unquote(item.getAttribute("href") ?? ""));
      const media = item.getAttribute("media-type") ?? "";
      if (!zip.has(href)) continue;
      if (media.startsWith("image/")) {
        images.push(href);
        continue;
      }
      let doc: Document | null;
      try {
        const bytes = zip.read(href);
        // Real-world XHTML often uses HTML entities that strict XML rejects; fall back to the HTML parser.
        doc = parseXml(bytes) ?? parseXml(bytes, "text/html");
      } catch {
        continue;
      }
      if (!doc) continue;
      const docDir = dirname(href);
      for (const el of descendants(doc.documentElement)) {
        const tag = localName(el).toLowerCase();
        const src = tag === "img" ? el.getAttribute("src")
          : tag === "image" ? el.getAttributeNS(XLINK_NS, "href") || el.getAttribute("xlink:href") || el.getAttribute("href")
            : null;
        if (src) {
          const target = joinPath(docDir, unquote(src));
          if (zip.has(target) && !images.includes(target)) images.push(target);
          break;
        }
      }
    }
  }
  return images;
}

// ── extracted archives (CBR / CB7) ───────────────────────────────────────────

function extractedComic(format: "cbr" | "cb7", files: Map<string, Uint8Array>, meta: EmbeddedFiles): LibraryComic {
  const pageNames = sortedPageImages(files.keys());
  let open = true;
  return {
    format,
    pageNames,
    pageCount: pageNames.length,
    async getPage(index) {
      if (!open) throw new ArchiveError("Comic is closed");
      checkIndex(index, pageNames.length);
      const data = files.get(pageNames[index])!;
      return { data, mime: mimeFor(data) };
    },
    async metadataFiles() {
      return { ...meta };
    },
    close() {
      open = false;
      files.clear();
    },
  };
}

const wasmCache = new Map<string, Promise<ArrayBuffer>>();

/** Wasm bytes from the caller or fetched once per URL (shared by every comic opened afterwards). */
function wasmBytes(given: ArrayBuffer | Uint8Array | undefined, url: string): Promise<ArrayBuffer> {
  if (given) return Promise.resolve(given instanceof Uint8Array ? exactBuffer(given) : given);
  let p = wasmCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new ArchiveError(`Could not load ${url} (HTTP ${r.status})`);
      return r.arrayBuffer();
    });
    p.catch(() => wasmCache.delete(url));
    wasmCache.set(url, p);
  }
  return p;
}

/** The view's bytes as a standalone ArrayBuffer; no copy when the view already spans its buffer. */
function exactBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer) {
    return view.buffer;
  }
  return view.slice().buffer as ArrayBuffer;
}

function wanted(name: string): boolean {
  return isPageImage(name) || metadataKey(name) !== undefined;
}

function collect(files: Map<string, Uint8Array>, meta: EmbeddedFiles, name: string, data: Uint8Array): void {
  const key = metadataKey(name);
  if (key) meta[key] = data;
  if (isPageImage(name)) files.set(name, data);
}

async function openRar(bytes: Uint8Array, options: OpenOptions): Promise<LibraryComic> {
  const { createExtractorFromData } = await import("node-unrar-js");
  const wasmBinary = await wasmBytes(options.unrarWasm, options.unrarWasmUrl ?? DEFAULT_UNRAR_WASM_URL);
  const files = new Map<string, Uint8Array>();
  const meta: EmbeddedFiles = {};
  try {
    const extractor = await createExtractorFromData({ wasmBinary, data: exactBuffer(bytes) });
    const { files: entries } = extractor.extract({
      files: (h) => !h.flags.directory && wanted(h.name.replace(/\\/g, "/")),
    });
    // The iterator must be drained or unrar's native archive handle leaks.
    for (const entry of entries) {
      if (entry.extraction) collect(files, meta, entry.fileHeader.name.replace(/\\/g, "/"), entry.extraction);
    }
  } catch (e) {
    throw new ArchiveError(`Could not extract RAR archive: ${(e as Error).message}`, { cause: e });
  }
  return extractedComic("cbr", files, meta);
}

const sevenZipLoaders = new Map<string, Promise<SevenZipModuleFactory>>();

function importSevenZip(url: string): Promise<SevenZipModuleFactory> {
  let p = sevenZipLoaders.get(url);
  if (!p) {
    p = import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ url)
      .then((m: { default: SevenZipModuleFactory }) => m.default)
      .catch((e) => {
        sevenZipLoaders.delete(url);
        throw new ArchiveError(`Could not load 7-Zip from ${url}`, { cause: e });
      });
    sevenZipLoaders.set(url, p);
  }
  return p;
}

async function open7z(bytes: Uint8Array, options: OpenOptions): Promise<LibraryComic> {
  const SevenZip = await (options.loadSevenZip?.() ?? importSevenZip(options.sevenZipJsUrl ?? DEFAULT_SEVEN_ZIP_JS_URL));
  const wasmBinary = await wasmBytes(options.sevenZipWasm, options.sevenZipWasmUrl ?? DEFAULT_SEVEN_ZIP_WASM_URL);
  const stderr: string[] = [];
  const sz = await SevenZip({
    wasmBinary,
    // EOF on stdin: emscripten's browser default would pop window.prompt() for a password.
    stdin: () => null as unknown as number,
    print: () => {},
    printErr: (s) => stderr.push(s),
  });
  const files = new Map<string, Uint8Array>();
  const meta: EmbeddedFiles = {};
  try {
    sz.FS.mkdir("/in");
    // canOwn: MEMFS keeps a view of the caller's bytes instead of copying a 300 MB archive.
    sz.FS.createDataFile("/in", "comic.7z", bytes, true, false, true);
    const code = (sz.callMain as unknown as (args: string[]) => number)(
      ["x", "/in/comic.7z", "-o/out", "-y", "-bd", "-bso0", "-bsp0"]);
    sz.FS.unlink("/in/comic.7z");
    if (code >= 2 || !exists(sz.FS, "/out")) {
      throw new ArchiveError(`Could not extract 7z archive: ${stderr.join(" ").trim().slice(0, 300) || `exit ${code}`}`);
    }
    // Unlinking as we copy keeps the peak near one copy of the pages rather than two.
    walk(sz.FS, "/out", "", (rel, path) => {
      if (wanted(rel)) collect(files, meta, rel, sz.FS.readFile(path));
      sz.FS.unlink(path);
    });
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError(`Could not extract 7z archive: ${(e as Error).message ?? e}`, { cause: e });
  }
  return extractedComic("cb7", files, meta);
}

type SevenZipFS = Awaited<ReturnType<SevenZipModuleFactory>>["FS"];

function exists(fs: SevenZipFS, path: string): boolean {
  try {
    fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function walk(fs: SevenZipFS, dir: string, rel: string, visit: (rel: string, path: string) => void): void {
  for (const name of fs.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`, relPath = rel ? `${rel}/${name}` : name;
    if (fs.isDir(fs.stat(path).mode)) walk(fs, path, relPath, visit);
    else visit(relPath, path);
  }
}

// ── PDF ──────────────────────────────────────────────────────────────────────

let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

/** Points the shared pdf.js instance at its worker script (openComic does this with the default URL). */
export async function setPdfWorkerUrl(url: string): Promise<void> {
  (await loadPdfjs()).GlobalWorkerOptions.workerSrc = url;
}

/** Renders at long side ~PDF_TARGET_LONG_SIDE (zoom capped at 4x, like the server) to JPEG on white. */
export async function renderPdfPageToJpeg(page: PDFPageProxy): Promise<ComicPageData> {
  const base = page.getViewport({ scale: 1 });
  const zoom = Math.min(4, PDF_TARGET_LONG_SIDE / (Math.max(base.width, base.height) || 1));
  const viewport = page.getViewport({ scale: zoom });
  const { canvas, ctx } = makeCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
  try {
    // pdf.js paints the white page background itself (PyMuPDF's alpha=False equivalent).
    const params = typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement
      ? { canvas, viewport }
      : { canvas: null, canvasContext: ctx as CanvasRenderingContext2D, viewport };
    await page.render(params).promise;
    return { data: await canvasToBytes(canvas, "image/jpeg", PDF_JPEG_QUALITY), mime: "image/jpeg" };
  } finally {
    releaseCanvas(canvas);
  }
}

async function openPdf(bytes: Uint8Array, options: OpenOptions): Promise<LibraryComic> {
  const pdfjs = await loadPdfjs();
  const workerUrl = options.pdfWorkerUrl === undefined ? DEFAULT_PDF_WORKER_URL : options.pdfWorkerUrl;
  if (workerUrl !== null && !pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: options.transferPdfBytes ? bytes : bytes.slice() });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    throw new ArchiveError(`Could not open PDF: ${(e as Error).message}`, { cause: e });
  }
  const render = options.renderPdfPage ?? renderPdfPageToJpeg;
  return {
    format: "pdf",
    pageNames: [],
    pageCount: doc.numPages,
    async getPage(index) {
      checkIndex(index, doc.numPages);
      const page = await doc.getPage(index + 1);
      try {
        return await render(page);
      } finally {
        page.cleanup();
      }
    },
    async metadataFiles() {
      const { info } = await doc.getMetadata();
      const title = (info as { Title?: unknown } | null)?.Title;
      return typeof title === "string" && title.trim() ? { pdfTitle: title.trim() } : {};
    },
    close() {
      void task.destroy();
    },
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Opens a comic file held in memory; pages are 0-based. `bytes` stays usable afterwards unless
 * `transferPdfBytes` is set. Options are layered over those given to configureLibrary.
 */
export async function openComic(bytes: Uint8Array, opts: OpenOptions = {}): Promise<LibraryComic> {
  const options = { ...defaults, ...opts };
  const format = options.format ?? detectFormat(bytes);
  switch (format) {
    case "cbz": {
      const zip = new ZipIndex(bytes);
      return zipComic("cbz", zip, sortedPageImages(zip.names));
    }
    case "epub": {
      const zip = new ZipIndex(bytes);
      const spine = epubSpineImages(zip);
      return zipComic("epub", zip, spine.length ? spine : sortedPageImages(zip.names));
    }
    case "cbr":
      return openRar(bytes, options);
    case "cb7":
      return open7z(bytes, options);
    case "pdf":
      return openPdf(bytes, options);
    default:
      throw new ArchiveError(`Unsupported format ${format as string}`);
  }
}
