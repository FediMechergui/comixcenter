/** Browser-only canvas plumbing shared by PDF rendering, panel detection and PDF export. */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Any2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Bytes as a Blob without copying (BlobPart typing rejects SharedArrayBuffer-backed views). */
export function bytesToBlob(data: Uint8Array, type = ""): Blob {
  return new Blob([data as Uint8Array<ArrayBuffer>], { type });
}

/** A DOM canvas on the main thread (what pdf.js is tested against), OffscreenCanvas in workers. */
export function makeCanvas(width: number, height: number): { canvas: AnyCanvas; ctx: Any2D } {
  let canvas: AnyCanvas;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  } else if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(width, height);
  } else {
    throw new Error("No canvas available in this environment");
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as Any2D | null;
  if (!ctx) throw new Error("2D canvas context unavailable");
  return { canvas, ctx };
}

export async function canvasToBytes(canvas: AnyCanvas, type: string, quality?: number): Promise<Uint8Array> {
  const blob = "convertToBlob" in canvas
    ? await canvas.convertToBlob({ type, quality })
    : await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas encoding failed"))), type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Frees the backing store now instead of waiting for GC (matters on phones with big pages). */
export function releaseCanvas(canvas: AnyCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}
