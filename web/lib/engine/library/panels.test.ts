import { describe, expect, it } from "vitest";
import { blankPage, fillRect, framedRect, gridPage } from "./fixtures";
import { detectPanels, workingGray } from "./panels";

/** Reference output of backend panels.detect_panels on the same synthetic pages (Pillow 12, numpy 2.5). */
const PY_GRID = [
  [0.05, 0.0333, 0.4267, 0.3011], [0.525, 0.0333, 0.4267, 0.3011],
  [0.05, 0.3667, 0.4267, 0.3011], [0.525, 0.3667, 0.4267, 0.3011],
  [0.05, 0.7, 0.9017, 0.2678],
];

/** 1000x1430 page (non-integer downscale) with a nested row: one tall panel beside a stacked pair. */
function nestedPage() {
  const c = blankPage(1000, 1430, [250, 248, 240]);
  const boxes = [[31, 29, 489, 700, 3], [503, 29, 969, 350, 2], [503, 363, 700, 700, 4], [713, 363, 969, 700, 1], [31, 713, 969, 1400, 5]];
  boxes.forEach(([x0, y0, x1, y1, w], i) =>
    framedRect(c, [x0, y0, x1, y1], w, [30, 30, 30], [120 + i * 25, 90 + i * 30, 200 - i * 35]));
  return c;
}

const PY_NESTED = [
  [0.0302, 0.02, 0.461, 0.4711], [0.5024, 0.02, 0.469, 0.2256], [0.5024, 0.2533, 0.1987, 0.2378],
  [0.7122, 0.2533, 0.2591, 0.2378], [0.0302, 0.4978, 0.9412, 0.4822],
];
const PY_NESTED_RTL = [PY_NESTED[1], PY_NESTED[3], PY_NESTED[2], PY_NESTED[0], PY_NESTED[4]];

describe("detectPanels", () => {
  it("finds the 2x2 grid and the wide bottom panel in reading order", () => {
    const { width, height, panels } = detectPanels(gridPage());
    expect([width, height]).toEqual([800, 1200]);
    expect(panels).toEqual(PY_GRID);
    const ys = panels.map((p) => p[1]);
    expect(ys[0] === ys[1] && ys[1] < ys[2] && ys[2] === ys[3] && ys[3] < ys[4]).toBe(true);
    expect(panels[4][2]).toBeGreaterThan(0.85);
  });

  it("flips columns, not rows, for right-to-left reading", () => {
    const { panels } = detectPanels(gridPage(), true);
    expect(panels.map((p) => p[0])).toEqual([0.525, 0.05, 0.525, 0.05, 0.05]);
    expect(panels.map((p) => p[1])).toEqual([0.0333, 0.0333, 0.3667, 0.3667, 0.7]);
  });

  it("treats a full-bleed page as one panel", () => {
    const page = blankPage(400, 600, [220, 60, 60]);
    fillRect(page, 20, 20, 80, 30, [255, 255, 255]);              // the "page 0" caption
    expect(detectPanels(page).panels).toEqual([[0, 0, 1, 1]]);
  });

  it("matches the Python boxes on a nested layout with a fractional downscale", () => {
    expect(detectPanels(nestedPage()).panels).toEqual(PY_NESTED);
    expect(detectPanels(nestedPage(), true).panels).toEqual(PY_NESTED_RTL);
  });

  it("reproduces Pillow's grey conversion and bilinear downscale exactly", () => {
    const { gray, width, height } = workingGray(nestedPage());
    expect([width, height]).toEqual([629, 900]);
    let sum = 0, weighted = 0;
    gray.forEach((v, i) => { sum += v; weighted += v * (i % 1009); });
    // numpy: a.sum(), (a * (arange(a.size).reshape(a.shape) % 1009)).sum()
    expect([sum, weighted]).toEqual([96949381, 48862141206]);
  });

  it("never upscales small pages", () => {
    const { width, height, panels } = detectPanels(blankPage(300, 200, [255, 255, 255]));
    expect([width, height, panels]).toEqual([300, 200, [[0, 0, 1, 1]]]);
  });
});
