/** Image helpers shared by the archive readers, the reader and PDF export (port of imaging.py). */

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"] as const;

export const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  bmp: "image/bmp", tif: "image/tiff", avif: "image/avif",
};

function startsWith(data: Uint8Array, offset: number, sig: string): boolean {
  if (data.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (data[offset + i] !== sig.charCodeAt(i)) return false;
  return true;
}

/** Extension from the magic bytes, or null when the bytes are not a known image format. */
export function sniffImageExtension(data: Uint8Array): string | null {
  if (startsWith(data, 0, "\xff\xd8\xff")) return "jpg";
  if (startsWith(data, 0, "\x89PNG\r\n\x1a\n")) return "png";
  if (startsWith(data, 0, "RIFF") && startsWith(data, 8, "WEBP")) return "webp";
  if (startsWith(data, 0, "GIF87a") || startsWith(data, 0, "GIF89a")) return "gif";
  if (startsWith(data, 0, "BM")) return "bmp";
  if (startsWith(data, 0, "II*\x00") || startsWith(data, 0, "MM\x00*")) return "tif";
  if (startsWith(data, 4, "ftypavif") || startsWith(data, 4, "ftypavis")) return "avif";
  return null;
}

/** File extension from the image's magic bytes, independent of the file name ("jpg" when unknown, like Python). */
export function detectImageExtension(data: Uint8Array): string {
  return sniffImageExtension(data) ?? "jpg";
}

export function mimeFor(data: Uint8Array): string {
  return IMAGE_MIME_TYPES[detectImageExtension(data)] ?? "application/octet-stream";
}

/** "page2" sorts before "page10": alternating text / number parts, text lower-cased. */
export function naturalSortKey(name: string): (string | number)[] {
  return name.split(/(\d+)/).map((part, i) => (i % 2 ? Number(part) : part.toLowerCase()));
}

/** Compares digit runs by value without Number precision limits ("0007" == "7", like Python's int()). */
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+/, ""), y = b.replace(/^0+/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Comparator equivalent to sorting by natural_sort_key in Python. */
export function naturalCompare(a: string, b: string): number {
  const ka = a.split(/(\d+)/), kb = b.split(/(\d+)/);
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    let c: number;
    if (i % 2) c = compareDigits(ka[i], kb[i]);
    else {
      const x = ka[i].toLowerCase(), y = kb[i].toLowerCase();
      c = x < y ? -1 : x > y ? 1 : 0;
    }
    if (c) return c;
  }
  return ka.length - kb.length;
}

/** Image entries inside an archive, skipping macOS resource forks and hidden files. */
export function isPageImage(name: string): boolean {
  const lower = name.toLowerCase();
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
    && !name.startsWith("__MACOSX/") && !base.startsWith(".");
}
