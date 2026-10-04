/**
 * Panel detection for the guided reader, by recursive XY-cut on gutters (port of panels.py).
 *
 * Comic pages separate panels with gutters: bands of near-background color running across the
 * page. We find full-width horizontal gutters (rows of the page), then full-height vertical gutters
 * inside each row, recursively, and trim each region to its content. Reading order is the cut
 * order: top to bottom, then left to right (right to left for manga).
 *
 * The grey conversion and the downscale reproduce Pillow's convert("L") and resize(BILINEAR)
 * integer arithmetic, so boxes match the Python server's to the 4 decimals it reports.
 */
import type { PanelBox } from "../contracts";
import { bytesToBlob, makeCanvas, releaseCanvas } from "./canvas";

export const WORK_LONG_SIDE = 900;          // detection runs on a downscaled copy
export const INK_THRESHOLD = 40;            // grey distance from the background that counts as content
export const GUTTER_INK_FRACTION = 0.01;    // a gutter line may carry at most 1% content pixels
export const MIN_GUTTER = 0.006;            // gutter thickness, fraction of the page side
export const MIN_PANEL_AREA = 0.015;        // smaller regions are noise (page numbers, captions in margins)
export const MAX_DEPTH = 6;

export interface RgbaImage { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
export interface PanelResult { width: number; height: number; panels: PanelBox[] }

type Box = [number, number, number, number]; // x0, y0, x1, y1 in working pixels

/** Pillow's RGB -> L (ITU-R 601-2 luma in 16-bit fixed point); alpha is ignored like convert("L"). */
function toGray(img: RgbaImage): Uint8Array {
  const { data } = img;
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (data[j] * 19595 + data[j + 1] * 38470 + data[j + 2] * 7471 + 0x8000) >>> 16;
  }
  return out;
}

const PRECISION_BITS = 32 - 8 - 2;

/** Pillow precompute_coeffs for the bilinear (triangle) filter, normalised to 8bpc fixed point. */
function coefficients(inSize: number, outSize: number): { bounds: Int32Array; ksize: number; kk: Float64Array } {
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = filterscale;            // bilinear support is 1.0
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Float64Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const ss = 1 / filterscale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    const base = xx * ksize;
    for (let x = 0; x < xmax; x++) {
      const t = Math.abs((x + xmin - center + 0.5) * ss);
      const w = t < 1 ? 1 - t : 0;
      kk[base + x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      const k = ww !== 0 ? kk[base + x] / ww : kk[base + x];
      kk[base + x] = k < 0 ? Math.trunc(-0.5 + k * (1 << PRECISION_BITS)) : Math.trunc(0.5 + k * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { bounds, ksize, kk };
}

function clip8(v: number): number {
  const r = Math.floor(v / (1 << PRECISION_BITS));
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

/** Pillow resize(BILINEAR) on an L image: horizontal pass, then vertical, rounding to 8 bits between. */
function resampleGray(src: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  let cur = src, cw = w;
  if (nw !== w) {
    const { bounds, ksize, kk } = coefficients(w, nw);
    const out = new Uint8Array(nw * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let xx = 0; xx < nw; xx++) {
        const xmin = bounds[xx * 2], xmax = bounds[xx * 2 + 1], k = xx * ksize;
        let ss = 1 << (PRECISION_BITS - 1);
        for (let x = 0; x < xmax; x++) ss += cur[row + xmin + x] * kk[k + x];
        out[y * nw + xx] = clip8(ss);
      }
    }
    cur = out;
    cw = nw;
  }
  if (nh !== h) {
    const { bounds, ksize, kk } = coefficients(h, nh);
    const out = new Uint8Array(cw * nh);
    for (let yy = 0; yy < nh; yy++) {
      const ymin = bounds[yy * 2], ymax = bounds[yy * 2 + 1], k = yy * ksize;
      for (let x = 0; x < cw; x++) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let y = 0; y < ymax; y++) ss += cur[(ymin + y) * cw + x] * kk[k + y];
        out[yy * cw + x] = clip8(ss);
      }
    }
    cur = out;
  }
  return cur;
}

/** Grey working copy at WORK_LONG_SIDE (never upscaled), as the Python code builds it. */
export function workingGray(img: RgbaImage): { gray: Uint8Array; width: number; height: number } {
  const { width, height } = img;
  const gray = toGray(img);
  const scale = WORK_LONG_SIDE / Math.max(width, height);
  if (scale >= 1) return { gray, width, height };
  const nw = Math.max(1, Math.trunc(width * scale)), nh = Math.max(1, Math.trunc(height * scale));
  return { gray: resampleGray(gray, width, height, nw, nh), width: nw, height: nh };
}

/** numpy median of the four borders (corners counted twice, even count averages the middle pair). */
function backgroundLevel(gray: Uint8Array, w: number, h: number): number {
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(gray[x]);
  for (let x = 0; x < w; x++) border.push(gray[(h - 1) * w + x]);
  for (let y = 0; y < h; y++) border.push(gray[y * w]);
  for (let y = 0; y < h; y++) border.push(gray[y * w + w - 1]);
  border.sort((a, b) => a - b);
  const mid = border.length >> 1;
  return border.length % 2 ? border[mid] : (border[mid - 1] + border[mid]) / 2;
}

class InkMap {
  constructor(readonly ink: Uint8Array, readonly w: number) {}

  /** Shrinks a box to the bounding box of its ink; an empty box when there is none. */
  trim([x0, y0, x1, y1]: Box): Box {
    let top = -1, bottom = -1, left = Infinity, right = -1;
    for (let y = y0; y < y1; y++) {
      const row = y * this.w;
      let first = -1, last = -1;
      for (let x = x0; x < x1; x++) {
        if (this.ink[row + x]) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first < 0) continue;
      if (top < 0) top = y;
      bottom = y;
      if (first < left) left = first;
      if (last > right) right = last;
    }
    if (top < 0) return [x0, y0, x0, y0];
    return [left, top, right + 1, bottom + 1];
  }

  /** Splits a box along gutters perpendicular to `axis` (0 = rows/horizontal gutters, 1 = columns). */
  split(box: Box, axis: 0 | 1, minGap: number): Box[] {
    const [x0, y0, x1, y1] = box;
    const bw = x1 - x0, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return [box];
    const length = axis === 0 ? bh : bw;
    const across = axis === 0 ? bw : bh;
    const clear = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      let count = 0;
      if (axis === 0) {
        const row = (y0 + i) * this.w;
        for (let x = x0; x < x1; x++) count += this.ink[row + x];
      } else {
        for (let y = y0; y < y1; y++) count += this.ink[y * this.w + x0 + i];
      }
      clear[i] = count / across <= GUTTER_INK_FRACTION ? 1 : 0;
    }
    const cuts: [number, number][] = [];
    let start = 0;
    for (const [s, e] of runs(clear)) {
      if (e - s < minGap) continue;
      if (s > start) cuts.push([start, s]);
      start = e;
    }
    if (start < length) cuts.push([start, length]);
    if (cuts.length <= 1) return [box];
    return axis === 0
      ? cuts.map(([a, b]) => [x0, y0 + a, x1, y0 + b] as Box)
      : cuts.map(([a, b]) => [x0 + a, y0, x0 + b, y1] as Box);
  }
}

/** [start, end) runs of set values. */
function runs(mask: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i] === 1;
    if (on && s < 0) s = i;
    else if (!on && s >= 0) {
      out.push([s, i]);
      s = -1;
    }
  }
  return out;
}

function xyCut(map: InkMap, input: Box, depth: number, minGapY: number, minGapX: number, rtl: boolean): Box[] {
  const box = map.trim(input);
  if (box[2] <= box[0] || box[3] <= box[1]) return [];
  if (depth >= MAX_DEPTH) return [box];
  for (const axis of [0, 1] as const) {
    let parts = map.split(box, axis, axis === 0 ? minGapY : minGapX);
    if (parts.length > 1) {
      if (axis === 1 && rtl) parts = parts.reverse();
      return parts.flatMap((part) => xyCut(map, part, depth + 1, minGapY, minGapX, rtl));
    }
  }
  return [box];
}

/** Python's round(v, 4) on the exact binary value (toFixed rounds the exact decimal expansion). */
const round4 = (v: number) => Number(v.toFixed(4));

/** Panels as [x, y, w, h] fractions of the page, in reading order; the whole page when nothing is found. */
export function detectPanels(img: RgbaImage, rtl = false): PanelResult {
  const { gray, width: w, height: h } = workingGray(img);
  const bg = backgroundLevel(gray, w, h);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = Math.abs(gray[i] - bg) > INK_THRESHOLD ? 1 : 0;
  const boxes = xyCut(new InkMap(ink, w), [0, 0, w, h], 0,
    Math.max(2, Math.trunc(h * MIN_GUTTER)), Math.max(2, Math.trunc(w * MIN_GUTTER)), rtl);
  const pageArea = w * h;
  let panels: PanelBox[] = boxes
    .filter((b) => (b[2] - b[0]) * (b[3] - b[1]) >= MIN_PANEL_AREA * pageArea)
    .map((b) => [b[0] / w, b[1] / h, (b[2] - b[0]) / w, (b[3] - b[1]) / h]);
  if (!panels.length) panels = [[0, 0, 1, 1]];
  return { width: img.width, height: img.height, panels: panels.map((p) => p.map(round4) as PanelBox) };
}

/** Above this long side the browser pre-shrinks the bitmap (bounded memory; results stay within rounding). */
const MAX_DECODE_LONG_SIDE = 3000;

/** Browser helper: decodes an encoded page and runs detectPanels; width/height are the original image's. */
export async function panelsFromImage(data: Uint8Array | Blob, rtl = false): Promise<PanelResult> {
  const blob = data instanceof Blob ? data : bytesToBlob(data);
  let bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const long = Math.max(width, height);
  if (long > MAX_DECODE_LONG_SIDE) {
    const f = MAX_DECODE_LONG_SIDE / long;
    bitmap.close();
    bitmap = await createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(width * f)), resizeHeight: Math.max(1, Math.round(height * f)),
      resizeQuality: "high",
    });
  }
  const { canvas, ctx } = makeCanvas(bitmap.width, bitmap.height);
  try {
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const result = detectPanels(pixels, rtl);
    return { ...result, width, height };
  } finally {
    bitmap.close();
    releaseCanvas(canvas);
  }
}

/** Name the engine's library store uses for panelsFromImage. */
export const detectPanelsInImage = panelsFromImage;
