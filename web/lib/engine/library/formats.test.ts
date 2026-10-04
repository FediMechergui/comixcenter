import { readFileSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { ArchiveError, detectFormat, openComic } from "./formats";
import { comicinfoXml, JPEG_BLUE, JPEG_RED, makeCbz, makeEpub, makePng, makeRar4 } from "./fixtures";

const modules = path.join(process.cwd(), "node_modules");
const unrarWasm = readFileSync(path.join(modules, "node-unrar-js/dist/js/unrar.wasm"));
const sevenZipWasm = readFileSync(path.join(modules, "7z-wasm/7zz.wasm"));
const nodeOptions = {
  unrarWasm, sevenZipWasm, pdfWorkerUrl: null,
  loadSevenZip: async () => (await import("7z-wasm")).default,
};

/** samples.make_cb7: pages/1.jpg, pages/2.jpg, built with 7-Zip itself. */
async function makeCb7(extra: Record<string, Uint8Array> = {}): Promise<Uint8Array> {
  const { default: SevenZip } = await import("7z-wasm");
  const sz = await SevenZip({ wasmBinary: sevenZipWasm.buffer.slice(0) as ArrayBuffer, print() {}, printErr() {} });
  sz.FS.mkdir("/src");
  sz.FS.mkdir("/src/pages");
  sz.FS.chdir("/src");
  sz.FS.writeFile("pages/1.jpg", JPEG_RED);
  sz.FS.writeFile("pages/2.jpg", JPEG_BLUE);
  for (const [name, data] of Object.entries(extra)) sz.FS.writeFile(name, data);
  sz.callMain(["a", "/out.7z", "pages", ...Object.keys(extra), "-bso0", "-bsp0"]);
  return sz.FS.readFile("/out.7z");
}

async function makePdf(pages: number, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  for (let i = 0; i < pages; i++) {
    const img = await doc.embedJpg(i % 2 ? JPEG_BLUE : JPEG_RED);
    doc.addPage([400, 600]).drawImage(img, { x: 0, y: 0, width: 400, height: 600 });
  }
  return doc.save();
}

describe("detectFormat", () => {
  it("identifies every format by magic bytes, not the extension", async () => {
    const cbz = makeCbz({ "p1.jpg": JPEG_RED });
    expect(detectFormat(cbz)).toBe("cbz");               // also what a zip renamed to .cbr gives
    expect(detectFormat(await makeCb7())).toBe("cb7");
    expect(detectFormat(makeEpub(2))).toBe("epub");
    expect(detectFormat(makeEpub(2, { withMimetype: false }))).toBe("epub");   // container + .opf
    expect(detectFormat(await makePdf(1))).toBe("pdf");
    expect(detectFormat(makeRar4([{ name: "a.jpg", data: JPEG_RED }]))).toBe("cbr");
    expect(detectFormat(strToU8("Rar!\x1a\x07\x01\x00rest-of-a-rar5"))).toBe("cbr");
  });

  it("rejects unknown and corrupt files", () => {
    expect(() => detectFormat(strToU8("hello world"))).toThrow(ArchiveError);
    expect(() => detectFormat(strToU8("PK\x03\x04garbage"))).toThrow(ArchiveError);
    expect(() => detectFormat(new Uint8Array())).toThrow(ArchiveError);
  });
});

describe("CBZ", () => {
  it("orders pages naturally, skips junk and finds metadata in any folder", async () => {
    const comic = await openComic(makeCbz({
      "p10.jpg": JPEG_RED, "p2.jpg": JPEG_BLUE, "p1.jpg": JPEG_RED,
      "__MACOSX/._p1.jpg": strToU8("junk"), "art/.hidden.png": makePng(2, 2), "readme.txt": strToU8("x"),
      "Extras/COMICINFO.XML": comicinfoXml("Saga", "1", 2012),
    }));
    expect(comic.format).toBe("cbz");
    expect(comic.pageNames).toEqual(["p1.jpg", "p2.jpg", "p10.jpg"]);
    expect(comic.pageCount).toBe(3);
    const page = await comic.getPage(1);
    expect(page.mime).toBe("image/jpeg");
    expect(page.data).toEqual(JPEG_BLUE);
    const meta = await comic.metadataFiles();
    expect(new TextDecoder().decode(meta.comicinfo)).toContain("<Series>Saga</Series>");
    expect(meta.metroninfo).toBeUndefined();
    await expect(comic.getPage(3)).rejects.toThrow(RangeError);
  });

  it("reports the page mime from the bytes, not the name", async () => {
    const comic = await openComic(zipSync({ "01.jpg": makePng(3, 3) }));
    expect((await comic.getPage(0)).mime).toBe("image/png");
  });
});

describe("EPUB", () => {
  it("reads pages in spine order", async () => {
    const comic = await openComic(makeEpub(3));
    expect(comic.format).toBe("epub");
    expect(comic.pageNames).toEqual(["OEBPS/images/img3.jpg", "OEBPS/images/img2.jpg", "OEBPS/images/img1.jpg"]);
    expect((await comic.getPage(0)).data).toEqual(JPEG_RED);    // img3
  });

  it("follows svg <image xlink:href> pages", async () => {
    const comic = await openComic(makeEpub(2, { svgPages: true }));
    expect(comic.pageNames).toEqual(["OEBPS/images/img2.jpg", "OEBPS/images/img1.jpg"]);
  });

  it("falls back to all images in natural order without a readable spine", async () => {
    const comic = await openComic(zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8("<container><broken"),
      "img/10.jpg": JPEG_RED, "img/9.jpg": JPEG_BLUE,
    }));
    expect(comic.format).toBe("epub");
    expect(comic.pageNames).toEqual(["img/9.jpg", "img/10.jpg"]);
  });
});

describe("CB7", () => {
  it("extracts with 7-Zip wasm at open", async () => {
    const comic = await openComic(await makeCb7({ "ComicInfo.xml": comicinfoXml("Saga", "2") }), nodeOptions);
    expect(comic.format).toBe("cb7");
    expect(comic.pageNames).toEqual(["pages/1.jpg", "pages/2.jpg"]);
    const page = await comic.getPage(1);
    expect(Array.from(page.data.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(page.data).toEqual(JPEG_BLUE);
    expect((await comic.metadataFiles()).comicinfo).toEqual(comicinfoXml("Saga", "2"));
    comic.close();
    await expect(comic.getPage(0)).rejects.toThrow(ArchiveError);
  });

  it("turns a damaged archive into ArchiveError", async () => {
    const bytes = await makeCb7();
    const broken = bytes.slice(0, 40);
    await expect(openComic(broken, nodeOptions)).rejects.toThrow(ArchiveError);
  });
});

describe("CBR", () => {
  it("extracts a RAR4 archive with unrar wasm", async () => {
    const rar = makeRar4([
      { name: "Issue\\p10.jpg", data: JPEG_RED },
      { name: "Issue\\p2.jpg", data: JPEG_BLUE },
      { name: "Issue\\MetronInfo.xml", data: strToU8("<MetronInfo><IDS><ID source=\"Metron\">7</ID></IDS></MetronInfo>") },
      { name: "notes.txt", data: strToU8("skip me") },
    ]);
    const comic = await openComic(rar, nodeOptions);
    expect(comic.format).toBe("cbr");
    expect(comic.pageNames).toEqual(["Issue/p2.jpg", "Issue/p10.jpg"]);
    expect((await comic.getPage(0)).data).toEqual(JPEG_BLUE);
    expect((await comic.getPage(1)).mime).toBe("image/jpeg");
    expect(new TextDecoder().decode((await comic.metadataFiles()).metroninfo)).toContain('source="Metron"');
  });

  it("turns a damaged archive into ArchiveError", async () => {
    const rar = makeRar4([{ name: "p1.jpg", data: JPEG_RED }]);
    rar[rar.length - 20] ^= 0xff;                     // corrupt the stored data -> CRC mismatch
    await expect(openComic(rar, nodeOptions)).rejects.toThrow(ArchiveError);
  });
});

describe("PDF", () => {
  it("counts pages, reads the title and renders through the page renderer", async () => {
    const rendered: number[] = [];
    const comic = await openComic(await makePdf(2, "Saga #1"), {
      ...nodeOptions,
      // Node has no canvas; the browser default (canvas + JPEG) is exercised on the device.
      renderPdfPage: async (page) => {
        rendered.push(page.pageNumber);
        return { data: JPEG_RED, mime: "image/jpeg" };
      },
    });
    expect(comic.format).toBe("pdf");
    expect(comic.pageCount).toBe(2);
    expect((await comic.getPage(1)).mime).toBe("image/jpeg");
    expect(rendered).toEqual([2]);
    expect(await comic.metadataFiles()).toEqual({ pdfTitle: "Saga #1" });
    await expect(comic.getPage(2)).rejects.toThrow(RangeError);
    comic.close();
  });

  it("leaves the caller's bytes usable unless told to transfer them", async () => {
    const bytes = await makePdf(1);
    const size = bytes.byteLength;
    (await openComic(bytes, nodeOptions)).close();
    expect(bytes.byteLength).toBe(size);                       // e.g. still writable as original.pdf
    const handed = await makePdf(1);
    const comic = await openComic(handed, { ...nodeOptions, transferPdfBytes: true });
    expect(comic.pageCount).toBe(1);
    expect(handed.byteLength).toBe(0);                         // detached by pdf.js, no copy made
    comic.close();
  });

  it("turns a broken PDF into ArchiveError", async () => {
    await expect(openComic(strToU8("%PDF-1.7\nnot really"), nodeOptions)).rejects.toThrow(ArchiveError);
  });
});
