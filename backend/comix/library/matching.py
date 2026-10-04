"""
Matches a library file to a catalog issue, strongest evidence first:

1. Source ids embedded by taggers (MetronInfo.xml IDs, ComicInfo Notes "[Issue ID n]")
2. Barcodes (ComicInfo GTIN against issue UPC/ISBN)
3. ComicInfo Series + Number (+ Volume / Year)
4. The file name, parsed like a release title ("Saga 054 (2018) (Digital).cbz")

Fuzzy matches above AUTO_MATCH are linked automatically; weaker ones are kept as candidates
for the person to confirm. When the series isn't in the catalog yet and Metron is configured,
a lookup job is queued, and the file is retried once that series has synced.
"""
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from rapidfuzz import fuzz, process
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from comix.config import get_settings
from comix.models import Issue, LibraryFile, Series
from comix.parsing import normalize_issue_number, parse_comic_title

AUTO_MATCH = 0.85
CANDIDATE_FLOOR = 0.55


@dataclass
class MatchResult:
    issue_id: Optional[int]
    method: Optional[str]
    confidence: float
    candidates: List[Dict[str, Any]]


def guess_from_filename(name: str) -> Dict[str, Any]:
    """Series / number / year from a file name like "Saga 054 (2018) (Digital) (Zone-Empire).cbz"."""
    stem = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", name)
    stem = stem.replace("_", " ")
    parsed = parse_comic_title(stem)
    series, number = parsed["series_name"], parsed["issue_number"]
    if not number:
        # Scanner style "Series 054 (2018)": a bare trailing number before the year/tags
        m = re.match(r"^(?P<series>.+?)\s+(?:v\d+\s+)?(?P<num>-?\d{1,4}(?:\.\d+)?)\s*(?:\(|$)", stem)
        if m:
            series = re.sub(r"\s*\(\d{4}.*$", "", m.group("series")).strip()
            number = normalize_issue_number(m.group("num"))
    vol = re.search(r"\bv(\d{1,2})\b", stem, re.IGNORECASE)
    return {"series": series, "number": number, "year": parsed["year"],
            "volume": parsed["volume"] or (vol.group(1) if vol else None)}


def _by_ids(session: Session, ids: Dict[str, int]) -> Optional[Issue]:
    if ids.get("metron"):
        issue = session.scalar(select(Issue).where(Issue.metron_id == ids["metron"]))
        if issue:
            return issue
    if ids.get("comicvine"):
        return session.scalar(select(Issue).where(Issue.cv_id == ids["comicvine"]))
    return None


def _year_fit(series: Series, year: Optional[int]) -> float:
    """1.0 when the year falls inside the run; decays with distance (a missing year is neutral)."""
    if not year:
        return 0.9
    start = series.first_cover_date.year if series.first_cover_date else series.year_began
    end = series.last_cover_date.year if series.last_cover_date else (series.year_end or start)
    if start is None:
        return 0.85
    end = max(end or start, start)
    if start - 1 <= year <= end + 1:
        return 1.0
    distance = min(abs(year - start), abs(year - end))
    return max(0.0, 1.0 - distance * 0.15)


def fuzzy_candidates(session: Session, series_name: str, number: Optional[str], year: Optional[int],
                     volume: Optional[str] = None, limit: int = 5) -> List[Dict[str, Any]]:
    if not series_name:
        return []
    rows = session.execute(select(Series.id, Series.name)).all()
    if not rows:
        return []
    names = {sid: name for sid, name in rows}
    hits = process.extract(series_name, names, scorer=fuzz.token_sort_ratio, limit=25, score_cutoff=70)
    norm_number = normalize_issue_number(number) if number else None
    out: List[Dict[str, Any]] = []
    for _name, name_score, series_id in hits:
        series = session.get(Series, series_id)
        issues = session.scalars(select(Issue).where(Issue.series_id == series_id)).all()
        target = None
        if norm_number is not None:
            target = next((i for i in issues if normalize_issue_number(i.number) == norm_number), None)
            if target is None:
                continue
        elif len(issues) == 1:
            target = issues[0]           # one-shots and graphic novels
        else:
            continue
        score = (name_score / 100) * _year_fit(series, year)
        if volume and series.volume and str(series.volume) != str(volume):
            score *= 0.9
        out.append({"issue_id": target.id, "series_id": series_id, "label": f"{series.name} ({series.year_began}) #{target.number}",
                    "confidence": round(score, 3), "cover": target.image_url})
    out.sort(key=lambda c: -c["confidence"])
    return out[:limit]


def match_file(session: Session, comicinfo: Dict[str, Any], filename: str) -> MatchResult:
    ids = comicinfo.get("ids") or {}
    issue = _by_ids(session, ids)
    if issue:
        return MatchResult(issue.id, "embedded-id", 1.0, [])

    gtin = re.sub(r"\D", "", comicinfo.get("GTIN") or "")
    if len(gtin) >= 10:
        issue = session.scalar(select(Issue).where(or_(Issue.upc == gtin, Issue.isbn == gtin)))
        if issue:
            return MatchResult(issue.id, "barcode", 0.98, [])

    candidates: List[Dict[str, Any]] = []
    method = None
    if comicinfo.get("Series"):
        year = int(comicinfo["Year"]) if str(comicinfo.get("Year", "")).isdigit() else None
        candidates = fuzzy_candidates(session, comicinfo["Series"], comicinfo.get("Number"), year, comicinfo.get("Volume"))
        method = "comicinfo"
    if not candidates or candidates[0]["confidence"] < AUTO_MATCH:
        guess = guess_from_filename(filename)
        by_name = fuzzy_candidates(session, guess["series"], guess["number"], guess["year"], guess["volume"])
        if by_name and (not candidates or by_name[0]["confidence"] > candidates[0]["confidence"]):
            candidates, method = by_name, "filename"
    if candidates and candidates[0]["confidence"] >= AUTO_MATCH:
        # Refuse to auto-pick when two different issues score the same
        if len(candidates) == 1 or candidates[1]["confidence"] < candidates[0]["confidence"] - 0.02:
            return MatchResult(candidates[0]["issue_id"], method, candidates[0]["confidence"], candidates)
    return MatchResult(None, None, candidates[0]["confidence"] if candidates else 0.0,
                       [c for c in candidates if c["confidence"] >= CANDIDATE_FLOOR])


def apply_match(session: Session, lf: LibraryFile, queue_lookup: bool = True) -> MatchResult:
    """Matches one file (unless manually matched) and queues a Metron lookup when nothing fits."""
    if lf.match_method == "manual":
        return MatchResult(lf.issue_id, "manual", 1.0, [])
    result = match_file(session, lf.comicinfo or {}, lf.original_name)
    lf.issue_id, lf.match_method, lf.match_confidence = result.issue_id, result.method, result.confidence
    parsed = dict(lf.parsed or {})
    parsed["candidates"] = result.candidates
    lf.parsed = parsed
    if result.issue_id is None and queue_lookup and get_settings().metron_configured:
        info = lf.comicinfo or {}
        name = info.get("Series") or parsed.get("series")
        year = info.get("SeriesYear") or info.get("Year") or parsed.get("year")
        if name and not parsed.get("lookup_queued"):
            from comix.ingest.jobs import P_USER, enqueue
            enqueue(session, "metron.find_series", {"name": name, "year": int(year) if str(year or "").isdigit() else None},
                    P_USER)
            parsed["lookup_queued"] = True
            lf.parsed = parsed
    session.flush()
    return result


def rematch_unmatched(session: Session, file_ids: Optional[List[int]] = None) -> Dict[str, int]:
    query = select(LibraryFile).where(LibraryFile.issue_id.is_(None), or_(
        LibraryFile.match_method.is_(None), LibraryFile.match_method != "manual"))
    if file_ids:
        query = query.where(LibraryFile.id.in_(file_ids))
    matched = checked = 0
    for lf in session.scalars(query):
        checked += 1
        if apply_match(session, lf, queue_lookup=False).issue_id:
            matched += 1
    return {"checked": checked, "matched": matched}
