import { describe, expect, it } from "vitest";
import { JPEG_RED, makePng } from "./fixtures";
import { detectImageExtension, isPageImage, mimeFor, naturalCompare, naturalSortKey, sniffImageExtension } from "./imaging";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("imaging", () => {
  it("sorts names naturally, case-insensitively", () => {
    const names = ["p10.jpg", "P2.jpg", "p1.jpg", "p02a.jpg", "cover.jpg", "p1.jpg.bak"];
    expect([...names].sort(naturalCompare)).toEqual(["cover.jpg", "p1.jpg", "p1.jpg.bak", "P2.jpg", "p02a.jpg", "p10.jpg"]);
    expect(naturalSortKey("Page10b")).toEqual(["page", 10, "b"]);
    expect(naturalCompare("x99999999999999999999", "x100000000000000000000")).toBeLessThan(0);
  });

  it("keeps page images and skips resource forks and hidden files", () => {
    expect(isPageImage("Saga/001.JPG")).toBe(true);
    expect(isPageImage("a.avif")).toBe(true);
    expect(isPageImage("__MACOSX/Saga/._001.jpg")).toBe(false);
    expect(isPageImage("Saga/.thumb.png")).toBe(false);
    expect(isPageImage("Saga\\.thumb.png")).toBe(false);
    expect(isPageImage("ComicInfo.xml")).toBe(false);
  });

  it("detects formats from magic bytes", () => {
    expect(detectImageExtension(JPEG_RED)).toBe("jpg");
    expect(detectImageExtension(makePng(1, 1))).toBe("png");
    expect(detectImageExtension(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(detectImageExtension(bytes("GIF89a..."))).toBe("gif");
    expect(detectImageExtension(bytes("BM......"))).toBe("bmp");
    expect(detectImageExtension(bytes("II*\0...."))).toBe("tif");
    expect(detectImageExtension(bytes("MM\0*...."))).toBe("tif");
    expect(detectImageExtension(bytes("\0\0\0\x1cftypavif"))).toBe("avif");
    expect(detectImageExtension(bytes("????"))).toBe("jpg");      // Python's default
    expect(sniffImageExtension(bytes("????"))).toBeNull();
    expect(mimeFor(makePng(1, 1))).toBe("image/png");
    expect(mimeFor(bytes("II*\0"))).toBe("image/tiff");
  });
});
