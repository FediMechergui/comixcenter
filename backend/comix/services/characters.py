"""Characters (mantles) and their identities, the appearance index, and team pages."""
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.orm import Session

from comix.models import (
    Appearance, Character, CharacterEvent, CharacterEventKind, Era, Identity, Issue, IssueUniverse, Membership,
    ReadingOrder, Series, SeriesUniverse, Team, TeamAffiliation, TeamAppearance, Universe,
)
from comix.services.catalog import issue_cards
from comix.services.teams import linked_teams, roster_timeline, shared_team_history


def _issue_label(session: Session, issue_id: Optional[int]) -> Optional[Dict[str, Any]]:
    if not issue_id:
        return None
    i = session.get(Issue, issue_id)
    return i and {"id": i.id, "label": f"{i.series.name} #{i.number}", "cover_date": i.cover_date, "image_url": i.image_url}


def list_characters(session: Session, q: Optional[str] = None, publisher_id: Optional[int] = None,
                    page: int = 1, size: int = 60) -> Dict[str, Any]:
    counts = select(Identity.character_id, func.count(Appearance.issue_id).label("apps")) \
        .join(Appearance, Appearance.identity_id == Identity.id, isouter=True).group_by(Identity.character_id).subquery()
    query = select(Character, func.coalesce(counts.c.apps, 0)).join(counts, counts.c.character_id == Character.id, isouter=True)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Character.name.ilike(like), Character.id.in_(
            select(Identity.character_id).where(or_(Identity.display_name.ilike(like), Identity.real_name.ilike(like))))))
    if publisher_id:
        query = query.where(Character.publisher_id == publisher_id)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.execute(query.order_by(func.coalesce(counts.c.apps, 0).desc(), Character.name)
                           .offset((max(page, 1) - 1) * size).limit(size)).all()
    return {"items": [{"id": c.id, "name": c.name, "image_url": c.image_url, "appearances": apps,
                       "identities": [i.display_name for i in c.identities]} for c, apps in rows],
            "total": total, "page": page, "size": size}


def character_detail(session: Session, character_id: int) -> Optional[Dict[str, Any]]:
    c = session.get(Character, character_id)
    if c is None:
        return None
    identities = []
    for ident in sorted(c.identities, key=lambda i: i.id):
        events = session.scalars(select(CharacterEvent).where(CharacterEvent.identity_id == ident.id)
                                 .order_by(CharacterEvent.kind)).all()
        apps = session.scalar(select(func.count()).select_from(Appearance).where(Appearance.identity_id == ident.id))
        span = session.execute(select(func.min(Issue.cover_date), func.max(Issue.cover_date))
                               .join(Appearance, Appearance.issue_id == Issue.id).where(Appearance.identity_id == ident.id)).one()
        identities.append({
            "id": ident.id, "name": ident.name, "display_name": ident.display_name, "real_name": ident.real_name,
            "aliases": ident.aliases or [], "description": ident.description, "image_url": ident.image_url,
            "appearances": apps, "first_seen": span[0], "last_seen": span[1],
            "first_appearance": _issue_label(session, ident.first_appearance_issue_id)
                                or ({"id": None, "label": ident.first_appearance_text} if ident.first_appearance_text else None),
            "events": [{"id": e.id, "kind": e.kind.value, "note": e.note, "source": e.source.value,
                        "issue": _issue_label(session, e.issue_id) or ({"id": None, "label": e.issue_text} if e.issue_text else None),
                        "end_issue": _issue_label(session, e.end_issue_id), "image_url": e.image_url}
                       for e in events],
            "metron_id": ident.metron_id, "cv_id": ident.cv_id,
        })
    teams = session.execute(text("""
        SELECT t.id, t.name, t.image_url, i.display_name AS identity,
               MIN(fi.cover_date) AS since, MAX(ti.cover_date) AS until
        FROM team_affiliations a JOIN teams t ON t.id = a.team_id JOIN identities i ON i.id = a.identity_id
        LEFT JOIN memberships m ON m.team_id = t.id AND m.identity_id = i.id
        LEFT JOIN issues fi ON fi.id = m.from_issue_id LEFT JOIN issues ti ON ti.id = m.to_issue_id
        WHERE i.character_id = :cid GROUP BY t.id, i.id ORDER BY since IS NULL, since, t.name"""), {"cid": c.id}).mappings().all()
    universes = session.execute(text("""
        SELECT u.id, u.name, COUNT(DISTINCT ap.issue_id) AS issues
        FROM appearances ap JOIN identities i ON i.id = ap.identity_id AND i.character_id = :cid
        JOIN issues iss ON iss.id = ap.issue_id
        JOIN series_universes su ON su.series_id = iss.series_id JOIN universes u ON u.id = su.universe_id
        GROUP BY u.id ORDER BY issues DESC"""), {"cid": c.id}).mappings().all()
    orders = session.scalars(select(ReadingOrder).where(ReadingOrder.character_id == c.id)).all()
    return {"id": c.id, "name": c.name, "description": c.description, "image_url": c.image_url,
            "publisher_id": c.publisher_id, "identities": identities,
            "appearances": sum(i["appearances"] for i in identities),
            "teams": [dict(t) for t in teams], "universes": [dict(u) for u in universes],
            "reading_orders": [{"id": o.id, "name": o.name} for o in orders]}


def appearances(session: Session, character_id: int, identity_id: Optional[int] = None, role: Optional[str] = None,
                universe_id: Optional[int] = None, era_id: Optional[int] = None, page: int = 1,
                size: int = 60) -> Dict[str, Any]:
    """Every issue the character appears in, filterable by identity, role, universe and era."""
    query = select(Issue, Appearance.role, Identity.display_name, Identity.id) \
        .join(Appearance, Appearance.issue_id == Issue.id).join(Identity, Identity.id == Appearance.identity_id) \
        .where(Identity.character_id == character_id)
    if identity_id:
        query = query.where(Identity.id == identity_id)
    if role:
        query = query.where(Appearance.role == role)
    era = session.get(Era, era_id) if era_id else None
    if era:
        universe_id = universe_id or era.universe_id
        query = query.where(Issue.cover_date >= era.start_date)
        if era.end_date:
            query = query.where(Issue.cover_date <= era.end_date)
    if universe_id:
        in_issue = select(IssueUniverse.issue_id).where(IssueUniverse.universe_id == universe_id)
        in_series = select(SeriesUniverse.series_id).where(SeriesUniverse.universe_id == universe_id)
        query = query.where(or_(Issue.id.in_(in_issue), Issue.series_id.in_(in_series)))
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.execute(query.order_by(Issue.cover_date, Issue.number_sort)
                           .offset((max(page, 1) - 1) * size).limit(size)).all()
    cards = {c["id"]: c for c in issue_cards(session, [r[0] for r in rows])}
    items = [dict(cards[i.id], role=r.value if r else None, identity=name, identity_id=iid) for i, r, name, iid in rows]
    return {"items": items, "total": total, "page": page, "size": size}


def list_teams(session: Session, q: Optional[str] = None, page: int = 1, size: int = 60) -> Dict[str, Any]:
    counts = select(TeamAppearance.team_id, func.count().label("apps")).group_by(TeamAppearance.team_id).subquery()
    members = select(TeamAffiliation.team_id, func.count().label("members")).group_by(TeamAffiliation.team_id).subquery()
    query = select(Team, func.coalesce(counts.c.apps, 0), func.coalesce(members.c.members, 0)) \
        .join(counts, counts.c.team_id == Team.id, isouter=True).join(members, members.c.team_id == Team.id, isouter=True)
    if q:
        query = query.where(Team.name.ilike(f"%{q.strip()}%"))
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.execute(query.order_by(func.coalesce(counts.c.apps, 0).desc(), Team.name)
                           .offset((max(page, 1) - 1) * size).limit(size)).all()
    return {"items": [{"id": t.id, "name": t.name, "image_url": t.image_url, "appearances": a, "members": m}
                      for t, a, m in rows], "total": total, "page": page, "size": size}


def team_detail(session: Session, team_id: int) -> Optional[Dict[str, Any]]:
    t = session.get(Team, team_id)
    if t is None:
        return None
    apps = session.scalar(select(func.count()).select_from(TeamAppearance).where(TeamAppearance.team_id == t.id))
    span = session.execute(select(func.min(Issue.cover_date), func.max(Issue.cover_date))
                           .join(TeamAppearance, TeamAppearance.issue_id == Issue.id).where(TeamAppearance.team_id == t.id)).one()
    affiliated = session.execute(select(Identity).join(TeamAffiliation, TeamAffiliation.identity_id == Identity.id)
                                 .where(TeamAffiliation.team_id == t.id)).scalars().all()
    orders = session.scalars(select(ReadingOrder).where(ReadingOrder.team_id == t.id)).all()
    return {"id": t.id, "name": t.name, "description": t.description, "image_url": t.image_url,
            "appearances": apps, "first_seen": span[0], "last_seen": span[1],
            "first_appearance": _issue_label(session, t.first_appearance_issue_id)
                                or ({"id": None, "label": t.first_appearance_text} if t.first_appearance_text else None),
            "disbanded": t.disbanded_text,
            "roster": roster_timeline(session, t.id),
            "members": [{"identity_id": i.id, "character_id": i.character_id, "name": i.character.name,
                         "identity": i.display_name, "image_url": i.image_url} for i in affiliated],
            "linked_teams": linked_teams(session, t.id),
            "reading_orders": [{"id": o.id, "name": o.name} for o in orders],
            "metron_id": t.metron_id, "cv_id": t.cv_id}


def team_issues(session: Session, team_id: int, page: int = 1, size: int = 60) -> Dict[str, Any]:
    query = select(Issue).join(TeamAppearance, TeamAppearance.issue_id == Issue.id).where(TeamAppearance.team_id == team_id)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.scalars(query.order_by(Issue.cover_date, Issue.number_sort).offset((max(page, 1) - 1) * size).limit(size)).all()
    return {"items": issue_cards(session, list(rows)), "total": total, "page": page, "size": size}


def character_graph(session: Session, character_id: int) -> Dict[str, Any]:
    return shared_team_history(session, character_id)
