"""Catalog browsing: publisher → universe → era → series → issue, plus issue and series pages."""
from collections import defaultdict
from datetime import date
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, exists, func, literal, or_, select, text
from sqlalchemy.orm import Session

from comix.bootstrap import DEFAULT_USER_ID
from comix.models import (
    Appearance, Arc, ArcIssue, CharacterEvent, CollectedIssue, Credit, Creator, Era, Identity, Imprint, Issue,
    IssueUniverse, LibraryFile, Publisher, ReadingOrder, ReadingOrderEntry, ReadStatus, Series, SeriesUniverse,
    Team, TeamAppearance, Universe,
)
from comix.services.legal import legal_links

COLLECTED_TYPES = ("trade paperback", "hard cover", "hardcover", "omnibus", "graphic novel")
MAX_PAGE_SIZE = 200


def _page(page: int, size: int) -> tuple[int, int]:
    size = max(1, min(size, MAX_PAGE_SIZE))
    return max(1, page), size


def series_start():
    return func.coalesce(Series.first_cover_date, func.printf("%04d-01-01", Series.year_began))


def series_end():
    return func.coalesce(Series.last_cover_date, func.printf("%04d-12-31", func.coalesce(Series.year_end, Series.year_began)),
                         series_start())


def era_overlap(era: Era):
    """Series whose cover-date span overlaps the era."""
    end = era.end_date.isoformat() if era.end_date else "9999-12-31"
    return and_(series_start() <= end, series_end() >= era.start_date.isoformat())


def series_card(s: Series) -> Dict[str, Any]:
    return {"id": s.id, "name": s.name, "volume": s.volume, "year_began": s.year_began, "year_end": s.year_end,
            "issue_count": s.issue_count, "image_url": s.image_url, "series_type": s.series_type,
            "publisher": s.publisher.name if s.publisher else None}


def issue_card(i: Issue, read: bool = False, owned: bool = False) -> Dict[str, Any]:
    return {"id": i.id, "series_id": i.series_id, "series_name": i.series.name, "series_year": i.series.year_began,
            "number": i.number, "title": i.title, "cover_date": i.cover_date, "image_url": i.image_url,
            "read": read, "owned": owned}


def read_issue_ids(session: Session, issue_ids: List[int], user_id: int = DEFAULT_USER_ID) -> set[int]:
    if not issue_ids:
        return set()
    return set(session.scalars(select(ReadStatus.issue_id).where(
        ReadStatus.user_id == user_id, ReadStatus.issue_id.in_(issue_ids))))


def owned_issue_ids(session: Session, issue_ids: List[int]) -> set[int]:
    if not issue_ids:
        return set()
    return set(session.scalars(select(LibraryFile.issue_id).where(LibraryFile.issue_id.in_(issue_ids))))


def issue_cards(session: Session, issues: List[Issue]) -> List[Dict[str, Any]]:
    ids = [i.id for i in issues]
    read, owned = read_issue_ids(session, ids), owned_issue_ids(session, ids)
    return [issue_card(i, i.id in read, i.id in owned) for i in issues]


# ── Browse ──────────────────────────────────────────────────────────────────

def list_publishers(session: Session) -> List[Dict[str, Any]]:
    counts = dict(session.execute(select(Series.publisher_id, func.count()).group_by(Series.publisher_id)).all())
    uni_counts = dict(session.execute(select(Universe.publisher_id, func.count()).group_by(Universe.publisher_id)).all())
    pubs = session.scalars(select(Publisher).order_by(Publisher.sort_order, Publisher.name)).all()
    out = [{"id": p.id, "name": p.name, "slug": p.slug, "image_url": p.image_url,
            "series_count": counts.get(p.id, 0), "universe_count": uni_counts.get(p.id, 0)} for p in pubs]
    # Seeded majors always show; others only once they have series
    return [p for p in out if p["series_count"] or p["universe_count"]]


def universe_card(session: Session, u: Universe) -> Dict[str, Any]:
    count = session.scalar(select(func.count()).select_from(SeriesUniverse).where(SeriesUniverse.universe_id == u.id))
    return {"id": u.id, "name": u.name, "slug": u.slug, "kind": u.kind.value, "designation": u.designation,
            "description": u.description, "series_count": count,
            "publisher": u.publisher.name if u.publisher else None}


def publisher_detail(session: Session, publisher_id: int) -> Optional[Dict[str, Any]]:
    p = session.get(Publisher, publisher_id)
    if p is None:
        return None
    universes = session.scalars(select(Universe).where(Universe.publisher_id == p.id)
                                .order_by(Universe.sort_order, Universe.name)).all()
    cross = session.scalars(select(Universe).where(Universe.publisher_id.is_(None)).order_by(Universe.sort_order)).all()
    unclassified = session.scalar(select(func.count()).select_from(Series).where(
        Series.publisher_id == p.id, ~exists().where(SeriesUniverse.series_id == Series.id)))
    imprints = session.scalars(select(Imprint).where(Imprint.publisher_id == p.id).order_by(Imprint.name)).all()
    return {
        "id": p.id, "name": p.name, "slug": p.slug, "description": p.description, "image_url": p.image_url,
        "founded": p.founded, "country": p.country,
        "universes": [universe_card(session, u) for u in universes],
        "cross_publisher_universes": [universe_card(session, u) for u in cross],
        "unclassified_series_count": unclassified,
        "imprints": [{"id": i.id, "name": i.name} for i in imprints],
    }


def universe_detail(session: Session, universe_id: int) -> Optional[Dict[str, Any]]:
    u = session.get(Universe, universe_id)
    if u is None:
        return None
    eras = []
    for era in u.eras:
        count = session.scalar(select(func.count()).select_from(Series).join(
            SeriesUniverse, and_(SeriesUniverse.series_id == Series.id, SeriesUniverse.universe_id == u.id))
            .where(era_overlap(era)))
        eras.append({"id": era.id, "name": era.name, "slug": era.slug, "start_date": era.start_date,
                     "end_date": era.end_date, "description": era.description, "series_count": count})
    orders = session.scalars(select(ReadingOrder).where(ReadingOrder.universe_id == u.id)).all()
    card = universe_card(session, u)
    card.update({"publisher_id": u.publisher_id, "eras": eras,
                 "reading_orders": [{"id": o.id, "name": o.name, "era_id": o.era_id} for o in orders]})
    return card


def list_series(session: Session, publisher_id: Optional[int] = None, universe_id: Optional[int] = None,
                era_id: Optional[int] = None, q: Optional[str] = None, unclassified: bool = False,
                collected: Optional[bool] = None, sort: str = "name", page: int = 1, size: int = 50) -> Dict[str, Any]:
    page, size = _page(page, size)
    query = select(Series)
    if publisher_id:
        query = query.where(Series.publisher_id == publisher_id)
    if universe_id:
        query = query.join(SeriesUniverse, and_(SeriesUniverse.series_id == Series.id,
                                                SeriesUniverse.universe_id == universe_id))
    if era_id:
        era = session.get(Era, era_id)
        if era is None:
            return {"items": [], "total": 0, "page": page, "size": size}
        if not universe_id:
            query = query.join(SeriesUniverse, and_(SeriesUniverse.series_id == Series.id,
                                                    SeriesUniverse.universe_id == era.universe_id))
        query = query.where(era_overlap(era))
    if unclassified:
        query = query.where(~exists().where(SeriesUniverse.series_id == Series.id))
    if q:
        query = query.where(Series.name.ilike(f"%{q.strip()}%"))
    if collected is not None:
        is_collected = func.lower(func.coalesce(Series.series_type, "")).in_(COLLECTED_TYPES)
        query = query.where(is_collected if collected else ~is_collected)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    order = {"year": (Series.year_began, Series.name), "recent": (series_end().desc(), Series.name)}.get(
        sort, (func.coalesce(Series.sort_name, Series.name), Series.year_began))
    rows = session.scalars(query.order_by(*order).offset((page - 1) * size).limit(size)).all()
    return {"items": [series_card(s) for s in rows], "total": total, "page": page, "size": size}


def overlapping_eras(session: Session, series: Series) -> List[Dict[str, Any]]:
    out = []
    for su in session.scalars(select(SeriesUniverse).where(SeriesUniverse.series_id == series.id)):
        for era in session.scalars(select(Era).where(Era.universe_id == su.universe_id)):
            hit = session.scalar(select(func.count()).select_from(Series).where(Series.id == series.id, era_overlap(era)))
            if hit:
                out.append({"id": era.id, "name": era.name, "universe_id": era.universe_id})
    return out


def series_detail(session: Session, series_id: int) -> Optional[Dict[str, Any]]:
    s = session.get(Series, series_id)
    if s is None:
        return None
    issues = session.scalars(select(Issue).where(Issue.series_id == s.id).order_by(Issue.number_sort, Issue.cover_date)).all()
    universes = session.execute(select(Universe, SeriesUniverse.source).join(
        SeriesUniverse, SeriesUniverse.universe_id == Universe.id).where(SeriesUniverse.series_id == s.id)).all()
    read = read_issue_ids(session, [i.id for i in issues])
    arcs = session.execute(select(Arc.id, Arc.name, Arc.kind, func.count()).join(ArcIssue, ArcIssue.arc_id == Arc.id)
                           .join(Issue, Issue.id == ArcIssue.issue_id).where(Issue.series_id == s.id)
                           .group_by(Arc.id).order_by(func.min(Issue.cover_date))).all()
    writers = session.execute(select(Creator.id, Creator.name, func.count()).join(Credit, Credit.creator_id == Creator.id)
                              .join(Issue, Issue.id == Credit.issue_id)
                              .where(Issue.series_id == s.id, Credit.role.ilike("%writer%"))
                              .group_by(Creator.id).order_by(func.count().desc()).limit(8)).all()
    card = series_card(s)
    card.update({
        "sort_name": s.sort_name, "status": s.status, "description": s.description,
        "publisher_id": s.publisher_id, "imprint": s.imprint.name if s.imprint else None,
        "first_cover_date": s.first_cover_date, "last_cover_date": s.last_cover_date,
        "metron_id": s.metron_id, "cv_id": s.cv_id, "synced_at": s.synced_at,
        "universes": [{"id": u.id, "name": u.name, "kind": u.kind.value, "source": src.value} for u, src in universes],
        "eras": overlapping_eras(session, s),
        "issues": issue_cards(session, list(issues)),
        "read_count": len(read),
        "arcs": [{"id": a, "name": n, "kind": k.value, "issue_count": c} for a, n, k, c in arcs],
        "writers": [{"id": c, "name": n, "issues": cnt} for c, n, cnt in writers],
    })
    return card


def issue_detail(session: Session, issue_id: int, user_id: int = DEFAULT_USER_ID) -> Optional[Dict[str, Any]]:
    i = session.get(Issue, issue_id)
    if i is None:
        return None
    s = i.series
    credits: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for role, cid, name in session.execute(select(Credit.role, Creator.id, Creator.name).join(Creator)
                                           .where(Credit.issue_id == i.id).order_by(Credit.role, Creator.name)):
        credits[role].append({"id": cid, "name": name})
    arcs = session.execute(select(Arc, ArcIssue.role, ArcIssue.tier).join(ArcIssue, ArcIssue.arc_id == Arc.id)
                           .where(ArcIssue.issue_id == i.id)).all()
    appearances = session.execute(select(Identity, Appearance.role).join(Appearance, Appearance.identity_id == Identity.id)
                                  .where(Appearance.issue_id == i.id)).all()
    teams = session.scalars(select(Team).join(TeamAppearance, TeamAppearance.team_id == Team.id)
                            .where(TeamAppearance.issue_id == i.id).order_by(Team.name)).all()
    universes = session.scalars(select(Universe).join(IssueUniverse).where(IssueUniverse.issue_id == i.id)).all() or \
        session.scalars(select(Universe).join(SeriesUniverse).where(SeriesUniverse.series_id == s.id)).all()
    collected_in = session.scalars(select(Issue).join(CollectedIssue, CollectedIssue.collection_issue_id == Issue.id)
                                   .where(CollectedIssue.issue_id == i.id)).all()
    collects = session.scalars(select(Issue).join(CollectedIssue, CollectedIssue.issue_id == Issue.id)
                               .where(CollectedIssue.collection_issue_id == i.id)
                               .order_by(Issue.cover_date, Issue.number_sort)).all()
    files = session.scalars(select(LibraryFile).where(LibraryFile.issue_id == i.id)).all()
    events = session.execute(select(CharacterEvent, Identity).join(Identity, Identity.id == CharacterEvent.identity_id)
                             .where(or_(CharacterEvent.issue_id == i.id,
                                        and_(CharacterEvent.cv_issue_id.is_not(None), CharacterEvent.cv_issue_id == i.cv_id)))).all()
    orders = session.execute(text("""
        SELECT DISTINCT o.id, o.name, e.tier FROM reading_orders o JOIN reading_order_entries e ON e.order_id = o.id
        WHERE e.issue_id = :iid OR e.arc_id IN (SELECT arc_id FROM arc_issues WHERE issue_id = :iid)
        ORDER BY o.name"""), {"iid": i.id}).all()
    prev_issue = session.scalar(select(Issue.id).where(Issue.series_id == s.id, Issue.number_sort < i.number_sort)
                                .order_by(Issue.number_sort.desc()).limit(1))
    next_issue = session.scalar(select(Issue.id).where(Issue.series_id == s.id, Issue.number_sort > i.number_sort)
                                .order_by(Issue.number_sort).limit(1))
    is_collection = (s.series_type or "").lower() in COLLECTED_TYPES or bool(collects)
    return {
        **issue_card(i, session.get(ReadStatus, (user_id, i.id)) is not None, bool(files)),
        "description": i.description, "store_date": i.store_date, "page_count": i.page_count,
        "isbn": i.isbn, "upc": i.upc, "metron_id": i.metron_id, "cv_id": i.cv_id,
        "deep_synced": i.deep_synced_at is not None,
        "series": series_card(s), "publisher_slug": s.publisher.slug if s.publisher else None,
        "credits": [{"role": r, "creators": c} for r, c in credits.items()],
        "arcs": [{"id": a.id, "name": a.name, "kind": a.kind.value, "role": role.value, "tier": tier.value if tier else None}
                 for a, role, tier in arcs],
        "characters": [{"identity_id": ident.id, "character_id": ident.character_id, "name": ident.character.name,
                        "identity": ident.display_name, "image_url": ident.image_url,
                        "role": role.value if role else None} for ident, role in appearances],
        "teams": [{"id": t.id, "name": t.name, "image_url": t.image_url} for t in teams],
        "universes": [{"id": u.id, "name": u.name, "kind": u.kind.value} for u in universes],
        "collected_in": issue_cards(session, list(collected_in)),
        "collects": issue_cards(session, list(collects)),
        "is_collection": is_collection,
        "files": [{"id": f.id, "name": f.original_name, "format": f.format, "page_count": f.page_count,
                   "current_page": f.current_page} for f in files],
        "events": [{"kind": e.kind.value, "identity_id": ident.id, "character_id": ident.character_id,
                    "name": ident.display_name, "note": e.note} for e, ident in events],
        "reading_orders": [{"id": oid, "name": name, "tier": tier} for oid, name, tier in orders],
        "previous_issue_id": prev_issue, "next_issue_id": next_issue,
        "legal_links": legal_links(s.name, i.number, s.year_began, s.publisher.slug if s.publisher else None, is_collection),
    }
