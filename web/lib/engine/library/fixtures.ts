/**
 * Test-only builders for small real comic files (CBZ, EPUB, RAR) and synthetic pages, mirroring
 * backend/tests/comix_app/samples.py. Not exported from index.ts.
 */
import { strToU8, zipSync, zlibSync } from "fflate";

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const JPEG_HEAD = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAYABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD";

/** 16x24 baseline JPEGs made by Pillow (red and blue), so each page is distinguishable. */
export const JPEG_RED = fromBase64(JPEG_HEAD + "EooorwD9bCiiigD//2Q==");
export const JPEG_BLUE = fromBase64(JPEG_HEAD + "zyiiiv1s4AooooA//2Q==");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Minimal truecolor PNG (8-bit RGB or RGBA), solid color. */
export function makePng(width: number, height: number, rgba: [number, number, number, number?] = [40, 160, 90]): Uint8Array {
  const channels = rgba[3] === undefined ? 3 : 4;
  const raw = new Uint8Array(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * channels);
    for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) raw[row + 1 + x * channels + c] = rgba[c]!;
  }
  const chunk = (type: string, body: Uint8Array) => {
    const td = concat([strToU8(type), body]);
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(td, 4);
    dv.setUint32(8 + body.length, crc32(td));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, channels === 3 ? 2 : 6, 0, 0, 0], 8);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array()),
  ]);
}

export function comicinfoXml(series: string, number: string, year?: number, notes?: string): Uint8Array {
  const parts = [`<Series>${series}</Series>`, `<Number>${number}</Number>`];
  if (year) parts.push(`<Year>${year}</Year>`);
  if (notes) parts.push(`<Notes>${notes}</Notes>`);
  return strToU8('<?xml version="1.0"?><ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + parts.join("") + "</ComicInfo>");
}

export function makeCbz(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

/** EPUB whose spine order (img3, img2, img1) deliberately differs from file-name order. */
export function makeEpub(pages = 3, { withMimetype = true, svgPages = false } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  if (withMimetype) files.mimetype = strToU8("application/epub+zip");
  files["META-INF/container.xml"] = strToU8(
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
    + '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const manifest: string[] = [], spine: string[] = [];
  for (let n = pages; n >= 1; n--) {
    files[`OEBPS/images/img${n}.jpg`] = n % 2 ? JPEG_RED : JPEG_BLUE;
    files[`OEBPS/page${n}.xhtml`] = strToU8(svgPages
      ? '<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg" '
        + `xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="images/img${n}.jpg"/></svg></body></html>`
      : `<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/img${n}.jpg"/></body></html>`);
    manifest.push(`<item id="p${n}" href="page${n}.xhtml" media-type="application/xhtml+xml"/>`);
    manifest.push(`<item id="i${n}" href="images/img${n}.jpg" media-type="image/jpeg"/>`);
    spine.push(`<itemref idref="p${n}"/>`);
  }
  files["OEBPS/content.opf"] = strToU8(
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>' + manifest.join("")
    + "</manifest><spine>" + spine.join("") + "</spine></package>");
  return zipSync(files);
}

/**
 * RAR 4.x archive with "stored" (uncompressed) entries, built from the published RAR 1.5-4.x
 * block layout: marker, main header, one file header + data per entry, end-of-archive block.
 * unrar verifies every header CRC and each file's CRC32, so a successful extraction proves it valid.
 */
export function makeRar4(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const block = (body: Uint8Array) => {
    // body starts at HEAD_TYPE; HEAD_CRC is the low 16 bits of CRC32 over it
    const out = new Uint8Array(2 + body.length);
    new DataView(out.buffer).setUint16(0, crc32(body) & 0xffff, true);
    out.set(body, 2);
    return out;
  };
  const marker = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const main = block(new Uint8Array([0x73, 0x00, 0x00, 13, 0x00, 0, 0, 0, 0, 0, 0]));
  const parts: Uint8Array[] = [marker, main];
  for (const { name, data } of entries) {
    const nameBytes = strToU8(name);
    const size = 32 + nameBytes.length;
    const body = new Uint8Array(size - 2);
    const dv = new DataView(body.buffer);
    body[0] = 0x74;                            // HEAD_TYPE: file
    dv.setUint16(1, 0x8000, true);             // HEAD_FLAGS: LONG_BLOCK (data follows)
    dv.setUint16(3, size, true);               // HEAD_SIZE
    dv.setUint32(5, data.length, true);        // PACK_SIZE
    dv.setUint32(9, data.length, true);        // UNP_SIZE
    body[13] = 2;                              // HOST_OS: Win32
    dv.setUint32(14, crc32(data), true);       // FILE_CRC
    dv.setUint32(18, 0x5a210000, true);        // FTIME (DOS date 2025-01-01)
    body[22] = 29;                             // UNP_VER 2.9
    body[23] = 0x30;                           // METHOD: store
    dv.setUint16(24, nameBytes.length, true);  // NAME_SIZE
    dv.setUint32(26, 0x20, true);              // ATTR: archive
    body.set(nameBytes, 30);
    parts.push(block(body), data);
  }
  parts.push(new Uint8Array([0xc4, 0x3d, 0x7b, 0x00, 0x40, 0x07, 0x00]));   // end of archive
  return concat(parts);
}

// ── synthetic pages as RGBA buffers ──────────────────────────────────────────

export interface Canvas { width: number; height: number; data: Uint8ClampedArray }

export function blankPage(width: number, height: number, rgb: [number, number, number]): Canvas {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([rgb[0], rgb[1], rgb[2], 255], i);
  return { width, height, data };
}

/** Fills the inclusive rectangle like Pillow's ImageDraw.rectangle. */
export function fillRect(c: Canvas, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) c.data.set(rgb, (y * c.width + x) * 4);
}

/** ImageDraw.rectangle(outline=..., width=w, fill=...): fill, with a w-pixel border drawn inward. */
export function framedRect(c: Canvas, [x0, y0, x1, y1]: number[], width: number,
  outline: [number, number, number], fill: [number, number, number]): void {
  fillRect(c, x0, y0, x1, y1, outline);
  fillRect(c, x0 + width, y0 + width, x1 - width, y1 - width, fill);
}

/** samples.grid_page(): white page, a 2x2 grid of framed panels above one wide panel; text drawn as a block. */
export function gridPage(): Canvas {
  const c = blankPage(800, 1200, [255, 255, 255]);
  const boxes = [[40, 40, 380, 400], [420, 40, 760, 400], [40, 440, 380, 800], [420, 440, 760, 800], [40, 840, 760, 1160]];
  boxes.forEach((b, i) => {
    framedRect(c, b, 6, [0, 0, 0], [200 - i * 20, 220, 240]);
    fillRect(c, b[0] + 20, b[1] + 20, b[0] + 80, b[1] + 30, [0, 0, 0]);
  });
  return c;
}
