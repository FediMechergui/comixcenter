import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { JPEG_RED, makePng } from "./fixtures";
import { imagesToPdf } from "./pdfExport";

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const WEBP_HEADER = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("imagesToPdf", () => {
  it("makes one page per image, embedding JPEG bytes untouched", async () => {
    const pdf = await imagesToPdf([
      { data: JPEG_RED, mime: "image/jpeg" },
      { data: makePng(30, 20, [10, 20, 30, 128]), mime: "image/png" },
      { data: JPEG_RED, mime: "image/jpeg" },
    ]);
    const head = new TextDecoder().decode(pdf.subarray(0, 5));
    expect(head).toBe("%PDF-");
    expect(indexOf(pdf, JPEG_RED)).toBeGreaterThan(0);           // no re-encode
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(3);
    // 16x24 px at img2pdf's default 96 dpi
    expect(doc.getPage(0).getSize()).toEqual({ width: 12, height: 18 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 22.5, height: 15 });
  });

  it("passes other formats through the converter", async () => {
    const convert = vi.fn(async () => ({ data: makePng(8, 8), mime: "image/png" }));
    const pdf = await imagesToPdf([{ data: WEBP_HEADER, mime: "image/webp" }, { data: JPEG_RED, mime: "image/jpeg" }], convert);
    expect(convert).toHaveBeenCalledTimes(1);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
  });

  it("rejects an empty list and converters that return the wrong format", async () => {
    await expect(imagesToPdf([])).rejects.toThrow("No images");
    const bad = async () => ({ data: WEBP_HEADER, mime: "image/webp" });
    await expect(imagesToPdf([{ data: WEBP_HEADER, mime: "image/webp" }], bad)).rejects.toThrow("JPEG or PNG");
  });
});
