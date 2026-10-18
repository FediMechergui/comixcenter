"""Read endpoints: catalog, search, arcs and events, reading orders, characters, teams, progress."""
from typing import List, Literal, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from comix.api.deps import DB, found
from comix.models import Arc, ArcIssue, Credit, Creator, Issue, ReadingOrder, Series, Universe
from comix.services import catalog, characters, orders, search as search_service
from comix.services.catalog import issue_cards

router = APIRouter(prefix="/api")
PathName = Literal["essential", "core", "complete", "all"]


# ── Catalog ──
@router.get("/publishers", tags=["catalog"])
def publishers(db: Session = DB):
    return catalog.list_publishers(db)


@router.get("/publishers/{publisher_id}", tags=["catalog"])
def publisher(publisher_id: int, db: Session = DB):
    return found(catalog.publisher_detail(db, publisher_id), "Publisher not found")


@router.get("/universes", tags=["catalog"])
def universes(db: Session = DB):
    return [catalog.universe_card(db, u) for u in db.scalars(select(Universe).order_by(Universe.sort_order, Universe.name))]


@router.get("/universes/{universe_id}", tags=["catalog"])
def universe(universe_id: int, db: Session = DB):
    return found(catalog.universe_detail(db, universe_id), "Universe not found")


@router.get("/series", tags=["catalog"])
def series_list(publisher_id: Optional[int] = None, universe_id: Optional[int] = None, era_id: Optional[int] = None,
                q: Optional[str] = None, unclassified: bool = False, collected: Optional[bool] = None,
                sort: Literal["name", "year", "recent"] = "name", page: int = 1, size: int = 50, db: Session = DB):
    return catalog.list_series(db, publisher_id, universe_id, era_id, q, unclassified, collected, sort, page, size)


@router.get("/series/{series_id}", tags=["catalog"])
def series(series_id: int, db: Session = DB):
    return found(catalog.series_detail(db, series_id), "Series not found")


@router.get("/issues/{issue_id}", tags=["catalog"])
def issue(issue_id: int, db: Session = DB):
    return found(catalog.issue_detail(db, issue_id), "Issue not found")


@router.get("/issues", tags=["catalog"])
def issues_search(q: str = Query(min_length=1), limit: int = 20, db: Session = DB):
    """Issue picker (manual library matching, curation): "saga 54", "amazing spider-man 300"."""
    hits = search_service.search(db, q, kinds=["issue"], limit=limit)["results"]
    found_issues = [db.get(Issue, h["id"]) for h in hits]
    return issue_cards(db, [i for i in found_issues if i])


@router.get("/search", tags=["catalog"])
def search(q: str = Query(min_length=1), kinds: Optional[str] = None, limit: int = 30, db: Session = DB):
    return search_service.search(db, q, kinds.split(",") if kinds else None, limit)


@router.get("/creators/{creator_id}", tags=["catalog"])
def creator(creator_id: int, db: Session = DB):
    c = found(db.get(Creator, creator_id), "Creator not found")
    runs = db.execute(select(Series.id, Series.name, Series.year_began, Credit.role, func.count(),
                             func.min(Issue.cover_date), func.max(Issue.cover_date))
                      .join(Issue, Issue.series_id == Series.id).join(Credit, Credit.issue_id == Issue.id)
                      .where(Credit.creator_id == c.id).group_by(Series.id, Credit.role)
                      .order_by(func.min(Issue.cover_date))).all()
    return {"id": c.id, "name": c.name, "runs": [
        {"series_id": sid, "series": name, "year": year, "role": role, "issues": n, "from": a, "to": b}
        for sid, name, year, role, n, a, b in runs],
        "reading_orders": [{"id": o.id, "name": o.name} for o in db.scalars(select(ReadingOrder).where(ReadingOrder.creator_id == c.id))]}


# ── Arcs and events ──
@router.get("/arcs", tags=["arcs"])
def arcs(q: Optional[str] = None, kind: Optional[Literal["arc", "event"]] = None, publisher_id: Optional[int] = None,
         page: int = 1, size: int = 50, db: Session = DB):
    return orders.list_arcs(db, q, kind, publisher_id, page, size)


@router.get("/arcs/{arc_id}", tags=["arcs"])
def arc(arc_id: int, db: Session = DB):
    return found(orders.arc_detail(db, arc_id), "Arc not found")


@router.get("/arcs/{arc_id}/plan", tags=["arcs"])
def arc_plan(arc_id: int, db: Session = DB):
    """What do I need to read before this arc? (prerequisite graph, in reading sequence)"""
    return found(orders.prerequisite_plan(db, arc_id), "Arc not found")


# ── Reading orders ──
@router.get("/orders", tags=["orders"])
def order_list(kind: Optional[str] = None, universe_id: Optional[int] = None, character_id: Optional[int] = None,
               team_id: Optional[int] = None, arc_id: Optional[int] = None, creator_id: Optional[int] = None,
               q: Optional[str] = None, db: Session = DB):
    return orders.list_orders(db, kind, universe_id, character_id, team_id, arc_id, creator_id, q)


@router.get("/orders/{order_id}", tags=["orders"])
def order(order_id: int, path: PathName = "core", db: Session = DB):
    return found(orders.order_detail(db, order_id, path), "Reading order not found")


class ReadThrough(BaseModel):
    entry_id: int
    path: PathName = "core"


@router.post("/orders/{order_id}/read-through", tags=["progress"])
def order_read_through(order_id: int, body: ReadThrough, db: Session = DB):
    found(db.get(ReadingOrder, order_id), "Reading order not found")
    changed = orders.mark_order_read_through(db, order_id, body.entry_id, body.path)
    db.commit()
    return {"marked": changed}


# ── Progress ──
class ReadFlag(BaseModel):
    read: bool = True


@router.put("/issues/{issue_id}/read", tags=["progress"])
def issue_read(issue_id: int, body: ReadFlag, db: Session = DB):
    found(db.get(Issue, issue_id), "Issue not found")
    orders.set_read(db, [issue_id], body.read)
    db.commit()
    return {"issue_id": issue_id, "read": body.read}


@router.put("/arcs/{arc_id}/read", tags=["progress"])
def arc_read(arc_id: int, body: ReadFlag, db: Session = DB):
    found(db.get(Arc, arc_id), "Arc not found")
    ids = list(db.scalars(select(ArcIssue.issue_id).where(ArcIssue.arc_id == arc_id)))
    changed = orders.set_read(db, ids, body.read)
    db.commit()
    return {"arc_id": arc_id, "changed": changed}


@router.put("/series/{series_id}/read", tags=["progress"])
def series_read(series_id: int, body: ReadFlag, db: Session = DB):
    found(db.get(Series, series_id), "Series not found")
    ids = list(db.scalars(select(Issue.id).where(Issue.series_id == series_id)))
    changed = orders.set_read(db, ids, body.read)
    db.commit()
    return {"series_id": series_id, "changed": changed}


@router.get("/progress", tags=["progress"])
def progress(db: Session = DB):
    return orders.progress_summary(db)


# ── Characters and teams ──
@router.get("/characters", tags=["characters"])
def character_list(q: Optional[str] = None, publisher_id: Optional[int] = None, page: int = 1, size: int = 60,
                   db: Session = DB):
    return characters.list_characters(db, q, publisher_id, page, size)


@router.get("/characters/{character_id}", tags=["characters"])
def character(character_id: int, db: Session = DB):
    return found(characters.character_detail(db, character_id), "Character not found")


@router.get("/characters/{character_id}/appearances", tags=["characters"])
def character_appearances(character_id: int, identity_id: Optional[int] = None,
                          role: Optional[Literal["main", "supporting", "cameo"]] = None,
                          universe_id: Optional[int] = None, era_id: Optional[int] = None,
                          page: int = 1, size: int = 60, db: Session = DB):
    return characters.appearances(db, character_id, identity_id, role, universe_id, era_id, page, size)


@router.get("/characters/{character_id}/graph", tags=["characters"])
def character_graph(character_id: int, db: Session = DB):
    return characters.character_graph(db, character_id)


@router.get("/teams", tags=["teams"])
def team_list(q: Optional[str] = None, page: int = 1, size: int = 60, db: Session = DB):
    return characters.list_teams(db, q, page, size)


@router.get("/teams/{team_id}", tags=["teams"])
def team(team_id: int, db: Session = DB):
    return found(characters.team_detail(db, team_id), "Team not found")


@router.get("/teams/{team_id}/issues", tags=["teams"])
def team_issues(team_id: int, page: int = 1, size: int = 60, db: Session = DB):
    return characters.team_issues(db, team_id, page, size)
