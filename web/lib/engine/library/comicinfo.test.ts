import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { extractIdsFromNotes, parseComicInfo, parseMetronInfo, readEmbeddedMetadata } from "./comicinfo";
import { comicinfoXml } from "./fixtures";

const METRON = strToU8(
  '<MetronInfo><IDS><ID source="Metron" primary="true">123</ID><ID source="Comic Vine">456</ID></IDS>'
  + "<Series><Name>Saga</Name><StartYear>2012</StartYear></Series><Number>54</Number>"
  + "<CoverDate>2018-07-01</CoverDate></MetronInfo>");

describe("tagger ids", () => {
  it("reads ComicTagger / Metron-Tagger notes and Comic Vine web links", () => {
    expect(extractIdsFromNotes("Tagged with ComicTagger using info from Comic Vine [Issue ID 6686]", null))
      .toEqual({ comicvine: 6686 });
    expect(extractIdsFromNotes("Tagged with MetronTagger using info from Metron [Issue ID 55]", null))
      .toEqual({ metron: 55 });
    expect(extractIdsFromNotes("[CVDB12]", undefined)).toEqual({ comicvine: 12 });
    expect(extractIdsFromNotes(null, "https://comicvine.gamespot.com/saga-1/4000-338623/")).toEqual({ comicvine: 338623 });
    expect(extractIdsFromNotes("from Metron [Issue ID 5]", "https://comicvine.gamespot.com/x/4000-9/"))
      .toEqual({ metron: 5, comicvine: 9 });
    expect(extractIdsFromNotes("no ids here", null)).toEqual({});
  });
});

describe("MetronInfo", () => {
  it("parses explicit ids, series and cover-date year", () => {
    const info = parseMetronInfo(METRON);
    expect(info.ids).toEqual({ metron: 123, comicvine: 456 });
    expect(info.Year).toBe("2018");
    expect(info.Series).toBe("Saga");
    expect(info.SeriesYear).toBe("2012");
    expect(info.Number).toBe("54");
    expect("Volume" in info).toBe(false);            // empty values are dropped
  });

  it("maps the Grand Comics Database source and ignores non-numeric ids", () => {
    const info = parseMetronInfo('<MetronInfo xmlns="urn:x"><IDS><ID source="Grand Comics Database">77</ID>'
      + '<ID source="Metron">abc</ID></IDS></MetronInfo>');
    expect(info.ids).toEqual({ gcd: 77 });
  });

  it("returns {} for malformed XML", () => {
    expect(parseMetronInfo("<MetronInfo><oops")).toEqual({});
  });
});

describe("ComicInfo", () => {
  it("reads the known fields and ids from Notes", () => {
    const info = parseComicInfo(comicinfoXml("Wrong Name", "9", 1988,
      "Tagged with ComicTagger using info from Comic Vine [Issue ID 7000]"));
    expect(info).toEqual({
      Series: "Wrong Name", Number: "9", Year: "1988",
      Notes: "Tagged with ComicTagger using info from Comic Vine [Issue ID 7000]",
      ids: { comicvine: 7000 },
    });
  });

  it("decodes UTF-16 files with a BOM", () => {
    const text = '<?xml version="1.0" encoding="utf-16"?><ComicInfo><Series>Astérix</Series></ComicInfo>';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) bytes[2 + i * 2] = text.charCodeAt(i);
    expect(parseComicInfo(bytes).Series).toBe("Astérix");
  });

  it("returns {} for malformed XML", () => {
    expect(parseComicInfo("not xml at all <")).toEqual({});
  });
});

describe("readEmbeddedMetadata", () => {
  it("merges MetronInfo over ComicInfo, ids included", () => {
    const info = readEmbeddedMetadata({
      comicinfo: comicinfoXml("Saga (2012)", "1", 2012, "using info from Comic Vine [Issue ID 999]"),
      metroninfo: METRON,
    });
    expect(info.Series).toBe("Saga");
    expect(info.Number).toBe("54");
    expect(info.Year).toBe("2018");
    expect(info.ids).toEqual({ comicvine: 456, metron: 123 });
  });

  it("uses the PDF title only when no series is known", () => {
    expect(readEmbeddedMetadata({ pdfTitle: "Saga 001" })).toEqual({ Title: "Saga 001" });
    expect(readEmbeddedMetadata({ pdfTitle: "x", comicinfo: comicinfoXml("Saga", "1") }).Title).toBeUndefined();
    expect(readEmbeddedMetadata({})).toEqual({});
  });
});
