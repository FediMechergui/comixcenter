/** Reads ComicInfo.xml (ComicRack / Anansi) and MetronInfo.xml metadata embedded in archives (port of comicinfo.py). */
import type { EmbeddedFiles } from "../contracts";
import { childText, descendants, localName, parseXml, child } from "./xml";

export const COMICINFO_FIELDS = [
  "Title", "Series", "Number", "Count", "Volume", "Year", "Month", "Day", "Publisher",
  "Imprint", "Summary", "Notes", "Web", "GTIN", "PageCount", "LanguageISO", "Writer",
  "Penciller", "Characters", "Teams", "StoryArc", "SeriesGroup", "Format",
] as const;

export interface EmbeddedIds { metron?: number; comicvine?: number; gcd?: number }

/** Same keys as the Python dicts; values stay strings exactly as found in the XML. */
export type EmbeddedMetadata = { [K in (typeof COMICINFO_FIELDS)[number]]?: string } & {
  SeriesYear?: string;
  CoverDate?: string;
  ids?: EmbeddedIds;
};

export function parseComicInfo(data: Uint8Array | string): EmbeddedMetadata {
  const root = parseXml(data)?.documentElement;
  if (!root) return {};
  const info: EmbeddedMetadata = {};
  for (const key of COMICINFO_FIELDS) {
    const value = childText(root, key);
    if (value) info[key] = value;
  }
  const ids = extractIdsFromNotes(info.Notes, info.Web);
  if (Object.keys(ids).length) info.ids = ids;
  return info;
}

/**
 * Taggers record the source issue id in Notes, e.g. ComicTagger:
 * "Tagged with ComicTagger 1.6 using info from Comic Vine on 2024-01-01. [Issue ID 123456]"
 * and Metron-Tagger: "... using info from Metron on ... [Issue ID 98765]".
 */
export function extractIdsFromNotes(notes?: string | null, web?: string | null): EmbeddedIds {
  const ids: EmbeddedIds = {};
  const text = notes ?? "";
  let m = /\[(?:CVDB|Issue ID)\s*(\d+)\]/i.exec(text);
  if (m) ids[/\bmetron\b/i.test(text) ? "metron" : "comicvine"] = parseInt(m[1], 10);
  m = /comicvine\.gamespot\.com\/[^/\s]+\/4000-(\d+)/i.exec(web ?? "");
  if (m && ids.comicvine === undefined) ids.comicvine = parseInt(m[1], 10);
  return ids;
}

const ID_SOURCES: Record<string, keyof EmbeddedIds> = {
  metron: "metron", comicvine: "comicvine", grandcomicsdatabase: "gcd",
};

/** MetronInfo.xml carries explicit source ids: <IDS><ID source="Metron" primary="true">123</ID>... */
export function parseMetronInfo(data: Uint8Array | string): EmbeddedMetadata {
  const root = parseXml(data)?.documentElement;
  if (!root) return {};
  const info: EmbeddedMetadata = {};
  const series = child(root, "Series");
  if (series) {
    info.Series = childText(series, "Name");
    info.Volume = childText(series, "Volume");
    const start = childText(series, "StartYear");
    if (start) info.SeriesYear = start;
  }
  for (const tag of ["Number", "CoverDate", "Summary", "GTIN"] as const) {
    const value = childText(root, tag);
    if (value) info[tag] = value;
  }
  if (info.CoverDate) info.Year = info.CoverDate.slice(0, 4);
  const ids: EmbeddedIds = {};
  for (const el of descendants(root)) {
    const text = (el.textContent ?? "").trim();
    if (localName(el) !== "ID" || !/^\d+$/.test(text)) continue;
    const key = ID_SOURCES[(el.getAttribute("source") ?? "").toLowerCase().replace(/ /g, "")];
    if (key && ids[key] === undefined) ids[key] = parseInt(text, 10);
  }
  if (Object.keys(ids).length) info.ids = ids;
  return dropEmpty(info);
}

function dropEmpty(info: EmbeddedMetadata): EmbeddedMetadata {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(info)) if (v) out[k] = v;
  return out as EmbeddedMetadata;
}

/** Merges MetronInfo (preferred, has explicit ids) over ComicInfo; a PDF title only fills in when nothing names the series. */
export function readEmbeddedMetadata(files: EmbeddedFiles): EmbeddedMetadata {
  let info: EmbeddedMetadata = {};
  if (files.comicinfo) info = parseComicInfo(files.comicinfo);
  if (files.metroninfo) {
    const { ids: metronIds, ...metron } = parseMetronInfo(files.metroninfo);
    const ids = { ...info.ids, ...metronIds };
    info = { ...info, ...dropEmpty(metron) };
    if (Object.keys(ids).length) info.ids = ids;
  }
  if (files.pdfTitle && !("Series" in info)) info.Title = files.pdfTitle;
  return info;
}
