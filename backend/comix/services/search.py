"""Full-text search over the catalog (SQLite FTS5 with prefix matching and bm25 ranking)."""
import re
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from comix.models import Arc, Character, Creator, Identity, Issue, ReadingOrder, Series, Team

KINDS = ("series", "issue", "arc", "character", "team", "creator", "order")


def fts_query(q: str) -> Optional[str]:
    """User text → FTS5 query: every word must match, each as a prefix ("spid man" finds Spider-Man)."""
    tokens = re.findall(r"\w+", q.lower(), re.UNICODE)
    if not tokens:
        return None
    return " ".join(f'"{t}"*' for t in tokens[:12])


def search(session: Session, q: str, kinds: Optional[Iterable[str]] = None, limit: int = 30) -> Dict[str, Any]:
    match = fts_query(q)
    if match is None:
        return {"query": q, "results": []}
    wanted = set(kinds or KINDS) & set(KINDS)
    if not wanted:
        return {"query": q, "results": []}
    fts_kinds = set(wanted) | ({"identity"} if "character" in wanted else set())
    rows = session.execute(text(f"""
        SELECT kind, ref_id, bm25(search_index, 0.0, 0.0, 10.0, 1.0) AS score
        FROM search_index WHERE search_index MATCH :match
          AND kind IN ({", ".join(f"'{k}'" for k in fts_kinds)})
        ORDER BY score LIMIT :limit"""), {"match": match, "limit": limit * 3}).all()

    results: List[Dict[str, Any]] = []
    seen = set()
    for kind, ref_id, score in rows:
        item = _describe(session, kind, ref_id)
        if item is None:
            continue
        key = (item["kind"], item["id"])
        if key in seen:
            continue   # an identity and its character both matched
        seen.add(key)
        item["score"] = round(-score, 3)
        results.append(item)
        if len(results) >= limit:
            break
    return {"query": q, "results": results}


def _describe(session: Session, kind: str, ref_id: int) -> Optional[Dict[str, Any]]:
    if kind == "series":
        s = session.get(Series, ref_id)
        return s and {"kind": "series", "id": s.id, "title": s.name,
                      "subtitle": " · ".join(filter(None, [str(s.year_began or ""), s.publisher.name if s.publisher else None,
                                                            f"{s.issue_count} issues" if s.issue_count else None])),
                      "image_url": s.image_url}
    if kind == "issue":
        i = session.get(Issue, ref_id)
        return i and {"kind": "issue", "id": i.id, "title": f"{i.series.name} #{i.number}",
                      "subtitle": " · ".join(filter(None, [i.title, str(i.cover_date.year) if i.cover_date else None])),
                      "image_url": i.image_url}
    if kind == "arc":
        a = session.get(Arc, ref_id)
        return a and {"kind": "arc", "id": a.id, "title": a.name, "subtitle": "Event" if a.kind.value == "event" else "Story arc",
                      "image_url": a.image_url}
    if kind in ("character", "identity"):
        if kind == "identity":
            ident = session.get(Identity, ref_id)
            if ident is None:
                return None
            c = ident.character
            subtitle = next((n for n in (ident.display_name, ident.real_name) if n and n != c.name), "")
        else:
            c = session.get(Character, ref_id)
            if c is None:
                return None
            people = [i.display_name for i in c.identities if i.display_name != c.name]
            subtitle = ", ".join(people[:3])
        return {"kind": "character", "id": c.id, "title": c.name, "subtitle": subtitle, "image_url": c.image_url}
    if kind == "team":
        t = session.get(Team, ref_id)
        return t and {"kind": "team", "id": t.id, "title": t.name, "subtitle": "Team", "image_url": t.image_url}
    if kind == "creator":
        c = session.get(Creator, ref_id)
        return c and {"kind": "creator", "id": c.id, "title": c.name, "subtitle": "Creator", "image_url": None}
    if kind == "order":
        o = session.get(ReadingOrder, ref_id)
        return o and {"kind": "order", "id": o.id, "title": o.name, "subtitle": "Reading order", "image_url": None}
    return None
