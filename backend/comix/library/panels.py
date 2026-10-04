"""
Panel detection for the guided reader, by recursive XY-cut on gutters.

Comic pages separate panels with gutters: bands of near-background color running across the
page. We find full-width horizontal gutters (rows of the page), then full-height vertical gutters
inside each row, recursively, and trim each region to its content. Reading order is the cut
order: top to bottom, then left to right (right to left for manga).
"""
import io
from typing import List, Tuple

import numpy as np
from PIL import Image

Box = Tuple[int, int, int, int]  # x0, y0, x1, y1 in working pixels

WORK_LONG_SIDE = 900          # detection runs on a downscaled copy
INK_THRESHOLD = 40            # grey distance from the background that counts as content
GUTTER_INK_FRACTION = 0.01    # a gutter line may carry at most 1% content pixels
MIN_GUTTER = 0.006            # gutter thickness, fraction of the page side
MIN_PANEL_AREA = 0.015        # smaller regions are noise (page numbers, captions in margins)
MAX_DEPTH = 6


def _background_level(gray: np.ndarray) -> float:
    border = np.concatenate([gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]])
    return float(np.median(border))


def _runs(mask: np.ndarray) -> List[Tuple[int, int]]:
    """[start, end) runs of True values."""
    padded = np.concatenate([[False], mask, [False]])
    diff = np.diff(padded.astype(np.int8))
    return list(zip(np.flatnonzero(diff == 1), np.flatnonzero(diff == -1)))


def _trim(ink: np.ndarray, box: Box) -> Box:
    x0, y0, x1, y1 = box
    region = ink[y0:y1, x0:x1]
    rows = np.flatnonzero(region.any(axis=1))
    cols = np.flatnonzero(region.any(axis=0))
    if rows.size == 0 or cols.size == 0:
        return (x0, y0, x0, y0)
    return (x0 + int(cols[0]), y0 + int(rows[0]), x0 + int(cols[-1]) + 1, y0 + int(rows[-1]) + 1)


def _split(ink: np.ndarray, box: Box, axis: int, min_gap: int) -> List[Box]:
    """Splits a box along gutters perpendicular to `axis` (0 = rows/horizontal gutters, 1 = columns)."""
    x0, y0, x1, y1 = box
    region = ink[y0:y1, x0:x1]
    if region.size == 0:
        return [box]
    profile = region.mean(axis=1 if axis == 0 else 0)
    gutters = [(s, e) for s, e in _runs(profile <= GUTTER_INK_FRACTION) if e - s >= min_gap]
    length = y1 - y0 if axis == 0 else x1 - x0
    cuts, start = [], 0
    for s, e in gutters:
        if s > start:
            cuts.append((start, s))
        start = e
    if start < length:
        cuts.append((start, length))
    if len(cuts) <= 1:
        return [box]
    if axis == 0:
        return [(x0, y0 + a, x1, y0 + b) for a, b in cuts]
    return [(x0 + a, y0, x0 + b, y1) for a, b in cuts]


def _xy_cut(ink: np.ndarray, box: Box, depth: int, min_gap_y: int, min_gap_x: int, rtl: bool) -> List[Box]:
    box = _trim(ink, box)
    if box[2] <= box[0] or box[3] <= box[1]:
        return []
    if depth >= MAX_DEPTH:
        return [box]
    for axis in (0, 1):
        parts = _split(ink, box, axis, min_gap_y if axis == 0 else min_gap_x)
        if len(parts) > 1:
            if axis == 1 and rtl:
                parts = parts[::-1]
            out: List[Box] = []
            for part in parts:
                out += _xy_cut(ink, part, depth + 1, min_gap_y, min_gap_x, rtl)
            return out
    return [box]


def detect_panels(image_bytes: bytes, rtl: bool = False) -> Tuple[int, int, List[List[float]]]:
    """Returns (width, height, panels) with panels as [x, y, w, h] fractions of the page, in reading order."""
    with Image.open(io.BytesIO(image_bytes)) as img:
        width, height = img.size
        scale = WORK_LONG_SIDE / max(width, height)
        work = img.convert("L")
        if scale < 1:
            work = work.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.BILINEAR)
        gray = np.asarray(work, dtype=np.int16)
    h, w = gray.shape
    ink = np.abs(gray - _background_level(gray)) > INK_THRESHOLD
    boxes = _xy_cut(ink, (0, 0, w, h), 0, max(2, int(h * MIN_GUTTER)), max(2, int(w * MIN_GUTTER)), rtl)
    page_area = float(w * h)
    panels = [[b[0] / w, b[1] / h, (b[2] - b[0]) / w, (b[3] - b[1]) / h]
              for b in boxes if (b[2] - b[0]) * (b[3] - b[1]) >= MIN_PANEL_AREA * page_area]
    if not panels:
        panels = [[0.0, 0.0, 1.0, 1.0]]
    return width, height, [[round(v, 4) for v in p] for p in panels]
