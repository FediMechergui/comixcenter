/**
 * Copies the on-device engine's runtime assets from node_modules into public/, because the app is
 * a static export served from the APK and can't load files out of node_modules at runtime.
 *
 *   public/wasm/unrar.wasm      node-unrar-js (CBR)
 *   public/wasm/7zz.wasm        7z-wasm (CB7)
 *   public/wasm/7zz.es6.js      7z-wasm's loader, imported at runtime rather than bundled: it
 *                               references Node built-ins that Turbopack refuses to resolve
 *   public/pdf.worker.min.mjs   pdf.js worker, from the *legacy* build: lib/engine/library imports
 *                               the legacy pdf.js (the modern build needs newer Chromium than 124),
 *                               and the worker must come from the same build.
 *
 * The URLs match DEFAULT_*_URL in lib/engine/library/formats.ts.
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = path.join(web, "node_modules");
const assets = [
  ["node-unrar-js/esm/js/unrar.wasm", "public/wasm/unrar.wasm"],
  ["7z-wasm/7zz.wasm", "public/wasm/7zz.wasm"],
  ["7z-wasm/7zz.es6.js", "public/wasm/7zz.es6.js"],
  ["pdfjs-dist/legacy/build/pdf.worker.min.mjs", "public/pdf.worker.min.mjs"],
];

for (const [from, to] of assets) {
  const src = path.join(modules, from);
  const dest = path.join(web, to);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`${to}  (${(statSync(dest).size / 1024).toFixed(0)} KB)`);
}
