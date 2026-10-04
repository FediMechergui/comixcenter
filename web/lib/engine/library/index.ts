/** Comic file formats, embedded metadata, panel detection, PDF export and OPDS parsing, on the device. */
export {
  ArchiveError, detectFormat, openComic, configureLibrary, setPdfWorkerUrl, renderPdfPageToJpeg,
  DEFAULT_ASSET_URLS, DEFAULT_UNRAR_WASM_URL, DEFAULT_SEVEN_ZIP_WASM_URL, DEFAULT_SEVEN_ZIP_JS_URL, DEFAULT_PDF_WORKER_URL,
  PDF_TARGET_LONG_SIDE, PDF_JPEG_QUALITY, SUPPORTED_EXTENSIONS,
} from "./formats";
export type { OpenOptions, LibraryComic, PdfPageRenderer, PdfjsModule } from "./formats";

export {
  COMICINFO_FIELDS, parseComicInfo, parseMetronInfo, extractIdsFromNotes, readEmbeddedMetadata,
} from "./comicinfo";
export type { EmbeddedMetadata, EmbeddedIds } from "./comicinfo";

export {
  detectPanels, panelsFromImage, detectPanelsInImage, workingGray,
  WORK_LONG_SIDE, INK_THRESHOLD, GUTTER_INK_FRACTION, MIN_GUTTER, MIN_PANEL_AREA, MAX_DEPTH,
} from "./panels";
export type { RgbaImage, PanelResult } from "./panels";

export { imagesToPdf, convertToPng } from "./pdfExport";
export type { PageConverter } from "./pdfExport";

export { parseOpdsFeed, OpdsError, COMIC_TYPES } from "./opds";
export type { OpdsFeed, OpdsEntry, OpdsAcquisition } from "./opds";

export {
  IMAGE_EXTENSIONS, IMAGE_MIME_TYPES, naturalSortKey, naturalCompare, isPageImage,
  detectImageExtension, sniffImageExtension, mimeFor,
} from "./imaging";
