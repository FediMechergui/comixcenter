"""Reads ComicInfo.xml (ComicRack / Anansi) and MetronInfo.xml metadata embedded in archives."""
import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, Optional

COMICINFO_FIELDS = ("Title", "Series", "Number", "Count", "Volume", "Year", "Month", "Day", "Publisher",
                    "Imprint", "Summary", "Notes", "Web", "GTIN", "PageCount", "LanguageISO", "Writer",
                    "Penciller", "Characters", "Teams", "StoryArc", "SeriesGroup", "Format")


def _text(root: ET.Element, tag: str) -> Optional[str]:
    el = root.find(f"{{*}}{tag}")
    if el is None:
        el = root.find(tag)
    value = (el.text or "").strip() if el is not None else ""
    return value or None


def parse_comicinfo(data: bytes) -> Dict[str, Any]:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return {}
    info: Dict[str, Any] = {k: v for k in COMICINFO_FIELDS if (v := _text(root, k))}
    ids = extract_ids_from_notes(info.get("Notes"), info.get("Web"))
    if ids:
        info["ids"] = ids
    return info


def extract_ids_from_notes(notes: Optional[str], web: Optional[str]) -> Dict[str, int]:
    """
    Taggers record the source issue id in Notes, e.g. ComicTagger:
    "Tagged with ComicTagger 1.6 using info from Comic Vine on 2024-01-01. [Issue ID 123456]"
    and Metron-Tagger: "... using info from Metron on ... [Issue ID 98765]".
    """
    ids: Dict[str, int] = {}
    text = notes or ""
    m = re.search(r"\[(?:CVDB|Issue ID)\s*(\d+)\]", text, re.IGNORECASE)
    if m:
        source = "metron" if re.search(r"\bmetron\b", text, re.IGNORECASE) else "comicvine"
        ids[source] = int(m.group(1))
    m = re.search(r"comicvine\.gamespot\.com/[^/\s]+/4000-(\d+)", web or "", re.IGNORECASE)
    if m:
        ids.setdefault("comicvine", int(m.group(1)))
    return ids


def parse_metroninfo(data: bytes) -> Dict[str, Any]:
    """MetronInfo.xml carries explicit source ids: <IDS><ID source="Metron" primary="true">123</ID>..."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return {}
    info: Dict[str, Any] = {}
    series = root.find("{*}Series") if root.find("{*}Series") is not None else root.find("Series")
    if series is not None:
        info["Series"] = _text(series, "Name")
        info["Volume"] = _text(series, "Volume")
        start = _text(series, "StartYear")
        if start:
            info["SeriesYear"] = start
    for tag in ("Number", "CoverDate", "Summary", "GTIN"):
        if (v := _text(root, tag)):
            info[tag] = v
    if info.get("CoverDate"):
        info["Year"] = info["CoverDate"][:4]
    ids: Dict[str, int] = {}
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == "ID" and (el.text or "").strip().isdigit():
            source = (el.get("source") or "").lower().replace(" ", "")
            key = {"metron": "metron", "comicvine": "comicvine", "grandcomicsdatabase": "gcd"}.get(source)
            if key:
                ids.setdefault(key, int(el.text.strip()))
    if ids:
        info["ids"] = ids
    return {k: v for k, v in info.items() if v}


def read_embedded_metadata(files: Dict[str, Any]) -> Dict[str, Any]:
    """Merges MetronInfo (preferred, has explicit ids) over ComicInfo."""
    info: Dict[str, Any] = {}
    if "comicinfo.xml" in files:
        info.update(parse_comicinfo(files["comicinfo.xml"]))
    if "metroninfo.xml" in files:
        metron = parse_metroninfo(files["metroninfo.xml"])
        ids = {**info.get("ids", {}), **metron.pop("ids", {})}
        info.update({k: v for k, v in metron.items() if v})
        if ids:
            info["ids"] = ids
    pdf = files.get("pdf")
    if isinstance(pdf, dict) and pdf.get("title") and "Series" not in info:
        info["Title"] = pdf["title"]
    return info
