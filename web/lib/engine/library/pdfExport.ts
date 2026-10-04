/**
 * Comic pages to PDF (the on-device counterpart of imaging.images_to_pdf): one page per image,
 * JPEG pages embedded as-is with no re-encode, PNG embedded losslessly, anything else converted.
 */
import type { ComicPageData } from "../contracts";
import { bytesToBlob, canvasToBytes, makeCanvas, releaseCanvas } from "./canvas";
import { sniffImageExtension } from "./imaging";

/** img2pdf assumes 96 dpi for images without a resolution; pages come out the same physical size. */
const POINTS_PER_PIXEL = 72 / 96;

export type PageConverter = (page: ComicPageData) => Promise<ComicPageData>;

/** Browser default for WEBP / GIF / BMP / AVIF / TIFF pages: decode, flatten onto white, lossless PNG. */
export async function convertToPng(page: ComicPageData): Promise<ComicPageData> {
  const bitmap = await createImageBitmap(bytesToBlob(page.data, page.mime));
  const { canvas, ctx } = makeCanvas(bitmap.width, bitmap.height);
  try {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    return { data: await canvasToBytes(canvas, "image/png"), mime: "image/png" };
  } finally {
    bitmap.close();
    releaseCanvas(canvas);
  }
}

export async function imagesToPdf(pages: ComicPageData[], convert: PageConverter = convertToPng): Promise<Uint8Array> {
  if (!pages.length) throw new Error("No images to convert.");
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (const [i, original] of pages.entries()) {
    let page = original;
    let kind = sniffImageExtension(page.data);
    if (kind !== "jpg" && kind !== "png") {
      page = await convert(page);
      kind = sniffImageExtension(page.data);
      if (kind !== "jpg" && kind !== "png") throw new Error(`Page ${i + 1}: converter must return JPEG or PNG`);
    }
    const image = kind === "jpg" ? await doc.embedJpg(page.data) : await doc.embedPng(page.data);
    const width = image.width * POINTS_PER_PIXEL, height = image.height * POINTS_PER_PIXEL;
    doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  return doc.save();
}
