"""
Curation and sync endpoints (the admin tool). Reading-order tiers, prerequisites, arc links,
identity grouping, memberships and the taxonomy are curated here; syncs are queued as jobs.
"""
from datetime import date
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from comix.api.deps import DB, Admin, found
from comix.ingest import jobs as jobqueue
from comix.ingest import metron_sync
from comix.ingest.clients import NotConfiguredError, get_metron
from comix.models import (
    Appearance, AppearanceRole, Arc, ArcIssue, ArcIssueRole, ArcKind, ArcLink, ArcLinkKind, Character, CharacterEvent,
    CharacterEventKind, Creator, EntryPrerequisite, Era, Identity, Issue, Job, JobStatus, Membership, OrderKind,
    Publisher, ReadingOrder, ReadingOrderEntry, Series, SeriesUniverse, Source, Team, TeamLink, TeamLinkKind, Tier,
    Universe, UniverseKind,
)
from comix.services import orders as order_service
from comix.services.teams import derive_memberships
from comix.starter_pack import apply_starter_pack, starter_arc_names
from comix.taxonomy import slugify

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Admin])


def _curated(order: ReadingOrder) -> None:
    """Any hand edit turns a generated draft into a curated order that regeneration won't overwrite."""
    order.source = Source.CURATED if order.source == Source.GENERATED else order.source


# ── Sync ────────────────────────────────────────────────────────────────────

@router.get("/metron/search")
def metron_search(kind: Literal["series", "arc", "character", "team", "reading_list"], q: str,
                  year: Optional[int] = None, db: Session = DB):
    try:
        results = metron_sync.search(get_metron(), kind, q, year)
    except NotConfiguredError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:  # noqa: BLE001 - show API errors (rate limits, auth) to the curator
        raise HTTPException(502, f"Metron error: {exc}")
    model = {"series": Series, "arc": Arc, "character": Identity, "team": Team, "reading_list": ReadingOrder}[kind]
    column = model.metron_reading_list_id if kind == "reading_list" else model.metron_id
    have = set(db.scalars(select(column).where(column.in_([r["metron_id"] for r in results] or [-1]))))
    for r in results:
        r["in_catalog"] = r["metron_id"] in have
    return results


class SyncRequest(BaseModel):
    kind: Literal["publishers", "series", "issue", "arc", "character", "team", "reading_list", "find_series",
                  "comicvine_identity", "comicvine_team", "comicvine_arc", "comicvine_issue", "derive_team"]
    metron_id: Optional[int] = None
    id: Optional[int] = None          # local id for Comic Vine enrichment / derivation
    name: Optional[str] = None
    year: Optional[int] = None
    deep: bool = True                 # also fetch every issue's full record
    with_issues: bool = True


@router.post("/sync")
def sync(body: SyncRequest, db: Session = DB):
    kind, payload = {
        "publishers": ("metron.publishers", {}),
        "series": ("metron.series", {"metron_id": body.metron_id, "deep": body.deep}),
        "issue": ("metron.issue", {"metron_id": body.metron_id}),
        "arc": ("metron.arc", {"metron_id": body.metron_id, "deep": body.deep}),
        "character": ("metron.character", {"metron_id": body.metron_id, "with_issues": body.with_issues}),
        "team": ("metron.team", {"metron_id": body.metron_id, "with_issues": body.with_issues}),
        "reading_list": ("metron.reading_list", {"metron_id": body.metron_id}),
        "find_series": ("metron.find_series", {"name": body.name, "year": body.year, "deep": body.deep}),
        "comicvine_identity": ("comicvine.identity", {"identity_id": body.id}),
        "comicvine_team": ("comicvine.team", {"team_id": body.id}),
        "comicvine_arc": ("comicvine.arc", {"arc_id": body.id}),
        "comicvine_issue": ("comicvine.issue", {"issue_id": body.id}),
        "derive_team": ("teams.derive", {"team_id": body.id}),
    }[body.kind]
    if any(v is None for k, v in payload.items() if k in ("metron_id", "identity_id", "team_id", "arc_id", "issue_id", "name")):
        raise HTTPException(422, "Missing id/name for this sync kind")
    job = jobqueue.enqueue(db, kind, payload, jobqueue.P_USER)
    db.commit()
    return job_card(job)


def job_card(j: Job) -> dict:
    return {"id": j.id, "kind": j.kind, "payload": j.payload, "status": j.status.value, "priority": j.priority,
            "attempts": j.attempts, "error": j.error, "result": j.result, "progress": j.progress,
            "created_at": j.created_at, "started_at": j.started_at, "finished_at": j.finished_at, "run_after": j.run_after}


@router.get("/jobs")
def job_list(status: Optional[Literal["queued", "running", "done", "failed"]] = None, limit: int = 100, db: Session = DB):
    query = select(Job)
    if status:
        query = query.where(Job.status == status)
    counts = dict(db.execute(select(Job.status, func.count()).group_by(Job.status)).all())
    jobs = db.scalars(query.order_by(Job.id.desc()).limit(limit)).all()
    return {"counts": {s.value: counts.get(s, 0) for s in JobStatus}, "jobs": [job_card(j) for j in jobs]}


@router.post("/jobs/{job_id}/retry")
def job_retry(job_id: int, db: Session = DB):
    job = found(db.get(Job, job_id), "Job not found")
    job.status, job.error, job.run_after = JobStatus.QUEUED, None, None
    db.commit()
    return job_card(job)


@router.delete("/jobs")
def job_clear(status: Literal["done", "failed"] = "done", db: Session = DB):
    n = db.execute(delete(Job).where(Job.status == status)).rowcount
    db.commit()
    return {"deleted": n}


@router.post("/starter-pack")
def starter_pack(db: Session = DB):
    result = apply_starter_pack(db)
    db.commit()
    return result


@router.get("/starter-pack/arcs")
def starter_pack_arcs():
    return starter_arc_names()


# ── Reading orders ──────────────────────────────────────────────────────────

class OrderIn(BaseModel):
    name: str
    kind: OrderKind = OrderKind.CUSTOM
    description: Optional[str] = None
    universe_id: Optional[int] = None
    era_id: Optional[int] = None
    character_id: Optional[int] = None
    team_id: Optional[int] = None
    arc_id: Optional[int] = None
    creator_id: Optional[int] = None


class OrderPatch(BaseModel):
    name: Optional[str] = None
    kind: Optional[OrderKind] = None
    description: Optional[str] = None


@router.post("/orders")
def order_create(body: OrderIn, db: Session = DB):
    order = ReadingOrder(**body.model_dump(), slug=order_service._unique_slug(db, body.name), source=Source.CURATED)
    db.add(order)
    db.commit()
    return order_service.order_card(db, order)


@router.patch("/orders/{order_id}")
def order_update(order_id: int, body: OrderPatch, db: Session = DB):
    order = found(db.get(ReadingOrder, order_id), "Reading order not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(order, key, value)
    _curated(order)
    db.commit()
    return order_service.order_card(db, order)


@router.delete("/orders/{order_id}")
def order_delete(order_id: int, db: Session = DB):
    db.delete(found(db.get(ReadingOrder, order_id), "Reading order not found"))
    db.commit()
    return {"deleted": order_id}


class EntryIn(BaseModel):
    issue_id: Optional[int] = None
    arc_id: Optional[int] = None
    tier: Tier = Tier.RECOMMENDED
    note: Optional[str] = None
    position: Optional[int] = None   # default: append; otherwise insert before this position

    @model_validator(mode="after")
    def one_target(self):
        if (self.issue_id is None) == (self.arc_id is None):
            raise ValueError("Give exactly one of issue_id or arc_id")
        return self


def _renumber(order: ReadingOrder) -> None:
    for pos, e in enumerate(sorted(order.entries, key=lambda e: (e.position, e.id or 0))):
        e.position = pos


@router.post("/orders/{order_id}/entries")
def entry_add(order_id: int, body: EntryIn, db: Session = DB):
    order = found(db.get(ReadingOrder, order_id), "Reading order not found")
    if body.issue_id:
        found(db.get(Issue, body.issue_id), "Issue not found")
    else:
        found(db.get(Arc, body.arc_id), "Arc not found")
    count = len(order.entries)
    pos = count if body.position is None else max(0, min(body.position, count))
    for e in order.entries:
        if e.position >= pos:
            e.position += 1
    entry = ReadingOrderEntry(position=pos, issue_id=body.issue_id, arc_id=body.arc_id, tier=body.tier, note=body.note)
    order.entries.append(entry)
    _curated(order)
    db.flush()
    _renumber(order)
    db.commit()
    return {"id": entry.id, "position": entry.position}


class EntryPatch(BaseModel):
    tier: Optional[Tier] = None
    note: Optional[str] = None
    position: Optional[int] = None


@router.patch("/entries/{entry_id}")
def entry_update(entry_id: int, body: EntryPatch, db: Session = DB):
    entry = found(db.get(ReadingOrderEntry, entry_id), "Entry not found")
    data = body.model_dump(exclude_unset=True)
    if "position" in data:
        ordered = [e for e in sorted(entry.order.entries, key=lambda e: e.position) if e.id != entry.id]
        ordered.insert(max(0, min(data.pop("position"), len(ordered))), entry)
        for pos, e in enumerate(ordered):
            e.position = pos
    for key, value in data.items():
        setattr(entry, key, value)
    _curated(entry.order)
    db.commit()
    return {"id": entry.id, "position": entry.position, "tier": entry.tier.value, "note": entry.note}


@router.delete("/entries/{entry_id}")
def entry_delete(entry_id: int, db: Session = DB):
    entry = found(db.get(ReadingOrderEntry, entry_id), "Entry not found")
    order = entry.order
    order.entries.remove(entry)
    _curated(order)
    db.flush()
    _renumber(order)
    db.commit()
    return {"deleted": entry_id}


class Reorder(BaseModel):
    entry_ids: List[int]


@router.post("/orders/{order_id}/reorder")
def order_reorder(order_id: int, body: Reorder, db: Session = DB):
    order = found(db.get(ReadingOrder, order_id), "Reading order not found")
    by_id = {e.id: e for e in order.entries}
    if set(body.entry_ids) != set(by_id):
        raise HTTPException(422, "entry_ids must list every entry of the order exactly once")
    for pos, eid in enumerate(body.entry_ids):
        by_id[eid].position = pos
    _curated(order)
    db.commit()
    return {"order_id": order_id, "entries": len(body.entry_ids)}


class BulkTier(BaseModel):
    entry_ids: List[int]
    tier: Tier


@router.post("/orders/{order_id}/tiers")
def order_bulk_tier(order_id: int, body: BulkTier, db: Session = DB):
    order = found(db.get(ReadingOrder, order_id), "Reading order not found")
    n = 0
    for e in order.entries:
        if e.id in body.entry_ids:
            e.tier, n = body.tier, n + 1
    _curated(order)
    db.commit()
    return {"updated": n}


class PrereqIn(BaseModel):
    requires_arc_id: Optional[int] = None
    requires_issue_id: Optional[int] = None
    note: Optional[str] = None

    @model_validator(mode="after")
    def one_target(self):
        if (self.requires_arc_id is None) == (self.requires_issue_id is None):
            raise ValueError("Give exactly one of requires_arc_id or requires_issue_id")
        return self


@router.post("/entries/{entry_id}/prerequisites")
def entry_prereq_add(entry_id: int, body: PrereqIn, db: Session = DB):
    entry = found(db.get(ReadingOrderEntry, entry_id), "Entry not found")
    prereq = EntryPrerequisite(entry_id=entry.id, **body.model_dump())
    db.add(prereq)
    _curated(entry.order)
    db.commit()
    return {"id": prereq.id}


@router.delete("/prerequisites/{prereq_id}")
def entry_prereq_delete(prereq_id: int, db: Session = DB):
    db.delete(found(db.get(EntryPrerequisite, prereq_id), "Prerequisite not found"))
    db.commit()
    return {"deleted": prereq_id}


class GenerateRequest(BaseModel):
    source: Literal["event", "character", "team", "writer", "universe"]
    id: int
    era_id: Optional[int] = None
    series_id: Optional[int] = None
    replace: bool = True


@router.post("/orders/generate")
def order_generate(body: GenerateRequest, db: Session = DB):
    model = {"event": Arc, "character": Character, "team": Team, "writer": Creator, "universe": Universe}[body.source]
    found(db.get(model, body.id), f"{body.source} not found")
    if body.source == "event":
        order = order_service.generate_event_order(db, body.id, body.replace)
    elif body.source == "character":
        order = order_service.generate_character_order(db, body.id, body.replace)
    elif body.source == "team":
        order = order_service.generate_team_order(db, body.id, body.replace)
    elif body.source == "writer":
        order = order_service.generate_writer_order(db, body.id, body.series_id, body.replace)
    else:
        order = order_service.generate_universe_order(db, body.id, body.era_id, body.replace)
    db.commit()
    return order_service.order_card(db, order)


# ── Arcs and events ─────────────────────────────────────────────────────────

class ArcIn(BaseModel):
    name: str
    kind: ArcKind = ArcKind.ARC
    description: Optional[str] = None
    publisher_id: Optional[int] = None
    issue_ids: List[int] = Field(default_factory=list)


class ArcPatch(BaseModel):
    name: Optional[str] = None
    kind: Optional[ArcKind] = None
    description: Optional[str] = None


@router.post("/arcs")
def arc_create(body: ArcIn, db: Session = DB):
    arc = Arc(name=body.name, kind=body.kind, description=body.description, publisher_id=body.publisher_id)
    db.add(arc)
    db.flush()
    for pos, iid in enumerate(body.issue_ids):
        found(db.get(Issue, iid), f"Issue {iid} not found")
        db.add(ArcIssue(arc_id=arc.id, issue_id=iid, position=pos))
    db.commit()
    return order_service.arc_summary(db, arc)


@router.patch("/arcs/{arc_id}")
def arc_update(arc_id: int, body: ArcPatch, db: Session = DB):
    arc = found(db.get(Arc, arc_id), "Arc not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(arc, key, value)
    db.commit()
    return order_service.arc_summary(db, arc)


class ArcIssueIn(BaseModel):
    issue_id: int
    role: ArcIssueRole = ArcIssueRole.CORE
    tier: Optional[Tier] = None
    position: Optional[int] = None


@router.post("/arcs/{arc_id}/issues")
def arc_issue_set(arc_id: int, body: ArcIssueIn, db: Session = DB):
    """Adds an issue to an arc/event, or updates its role (core / tie-in), tie-in tier and position."""
    found(db.get(Arc, arc_id), "Arc not found")
    found(db.get(Issue, body.issue_id), "Issue not found")
    link = db.get(ArcIssue, (arc_id, body.issue_id))
    if link is None:
        last = db.scalar(select(func.max(ArcIssue.position)).where(ArcIssue.arc_id == arc_id))
        link = ArcIssue(arc_id=arc_id, issue_id=body.issue_id, position=(last or 0) + 1 if body.position is None else body.position)
        db.add(link)
    elif body.position is not None:
        link.position = body.position
    link.role, link.tier = body.role, body.tier
    db.commit()
    return {"arc_id": arc_id, "issue_id": body.issue_id, "role": link.role.value, "tier": link.tier.value if link.tier else None}


@router.delete("/arcs/{arc_id}/issues/{issue_id}")
def arc_issue_remove(arc_id: int, issue_id: int, db: Session = DB):
    db.delete(found(db.get(ArcIssue, (arc_id, issue_id)), "Issue is not in this arc"))
    db.commit()
    return {"deleted": [arc_id, issue_id]}


class ArcLinkIn(BaseModel):
    target_arc_id: int
    kind: ArcLinkKind
    note: Optional[str] = None


@router.post("/arcs/{arc_id}/links")
def arc_link_add(arc_id: int, body: ArcLinkIn, db: Session = DB):
    found(db.get(Arc, arc_id), "Arc not found")
    found(db.get(Arc, body.target_arc_id), "Target arc not found")
    if body.kind == ArcLinkKind.PREREQUISITE and order_service.would_create_cycle(db, arc_id, body.target_arc_id):
        raise HTTPException(409, "That would make the prerequisites circular")
    exists = db.scalar(select(ArcLink).where(ArcLink.arc_id == arc_id, ArcLink.target_arc_id == body.target_arc_id,
                                             ArcLink.kind == body.kind))
    if exists:
        exists.note = body.note
        link = exists
    else:
        link = ArcLink(arc_id=arc_id, target_arc_id=body.target_arc_id, kind=body.kind, note=body.note, source=Source.CURATED)
        db.add(link)
    db.commit()
    return {"id": link.id}


@router.delete("/arc-links/{link_id}")
def arc_link_delete(link_id: int, db: Session = DB):
    db.delete(found(db.get(ArcLink, link_id), "Link not found"))
    db.commit()
    return {"deleted": link_id}


# ── Characters, identities, appearances ─────────────────────────────────────

class CharacterIn(BaseModel):
    name: str
    description: Optional[str] = None
    image_url: Optional[str] = None
    publisher_id: Optional[int] = None


@router.post("/characters")
def character_create(body: CharacterIn, db: Session = DB):
    c = Character(**body.model_dump())
    db.add(c)
    db.commit()
    return {"id": c.id, "name": c.name}


class CharacterPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    image_url: Optional[str] = None


@router.patch("/characters/{character_id}")
def character_update(character_id: int, body: CharacterPatch, db: Session = DB):
    c = found(db.get(Character, character_id), "Character not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(c, key, value)
    db.commit()
    return {"id": c.id, "name": c.name}


class IdentityPatch(BaseModel):
    character_id: Optional[int] = None    # regroup under another mantle
    display_name: Optional[str] = None


@router.patch("/identities/{identity_id}")
def identity_update(identity_id: int, body: IdentityPatch, db: Session = DB):
    ident = found(db.get(Identity, identity_id), "Identity not found")
    old_character = ident.character_id
    if body.character_id is not None:
        found(db.get(Character, body.character_id), "Character not found")
        ident.character_id = body.character_id
    if body.display_name:
        ident.display_name = body.display_name
    db.flush()
    # A mantle left with no identities is removed
    if old_character != ident.character_id and not db.scalar(select(func.count()).select_from(Identity).where(Identity.character_id == old_character)):
        db.execute(update(ReadingOrder).where(ReadingOrder.character_id == old_character).values(character_id=ident.character_id))
        db.delete(db.get(Character, old_character))
    db.commit()
    return {"id": ident.id, "character_id": ident.character_id, "display_name": ident.display_name}


class EventIn(BaseModel):
    identity_id: int
    kind: CharacterEventKind
    issue_id: Optional[int] = None
    issue_text: Optional[str] = None
    end_issue_id: Optional[int] = None
    note: Optional[str] = None
    image_url: Optional[str] = None


@router.post("/character-events")
def event_create(body: EventIn, db: Session = DB):
    ident = found(db.get(Identity, body.identity_id), "Identity not found")
    event = CharacterEvent(**body.model_dump(), source=Source.CURATED)
    db.add(event)
    if body.kind == CharacterEventKind.FIRST_APPEARANCE and body.issue_id:
        ident.first_appearance_issue_id = body.issue_id
    db.commit()
    return {"id": event.id}


@router.delete("/character-events/{event_id}")
def event_delete(event_id: int, db: Session = DB):
    db.delete(found(db.get(CharacterEvent, event_id), "Event not found"))
    db.commit()
    return {"deleted": event_id}


class AppearanceRoleIn(BaseModel):
    issue_id: int
    identity_id: int
    role: AppearanceRole


@router.put("/appearances")
def appearance_role(body: AppearanceRoleIn, db: Session = DB):
    app = db.get(Appearance, (body.issue_id, body.identity_id))
    if app is None:
        found(db.get(Issue, body.issue_id), "Issue not found")
        found(db.get(Identity, body.identity_id), "Identity not found")
        app = Appearance(issue_id=body.issue_id, identity_id=body.identity_id)
        db.add(app)
    app.role, app.role_source = body.role, Source.CURATED
    db.commit()
    return {"issue_id": body.issue_id, "identity_id": body.identity_id, "role": body.role.value}


# ── Teams ───────────────────────────────────────────────────────────────────

class MembershipIn(BaseModel):
    team_id: int
    identity_id: int
    from_issue_id: Optional[int] = None
    to_issue_id: Optional[int] = None
    note: Optional[str] = None


@router.post("/memberships")
def membership_create(body: MembershipIn, db: Session = DB):
    found(db.get(Team, body.team_id), "Team not found")
    found(db.get(Identity, body.identity_id), "Identity not found")
    m = Membership(**body.model_dump(), source=Source.CURATED)
    db.add(m)
    db.commit()
    return {"id": m.id}


class MembershipPatch(BaseModel):
    from_issue_id: Optional[int] = None
    to_issue_id: Optional[int] = None
    note: Optional[str] = None


@router.patch("/memberships/{membership_id}")
def membership_update(membership_id: int, body: MembershipPatch, db: Session = DB):
    m = found(db.get(Membership, membership_id), "Membership not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(m, key, value)
    m.source = Source.CURATED
    db.commit()
    return {"id": m.id}


@router.delete("/memberships/{membership_id}")
def membership_delete(membership_id: int, db: Session = DB):
    db.delete(found(db.get(Membership, membership_id), "Membership not found"))
    db.commit()
    return {"deleted": membership_id}


@router.post("/teams/{team_id}/derive")
def team_derive(team_id: int, db: Session = DB):
    found(db.get(Team, team_id), "Team not found")
    result = derive_memberships(db, team_id)
    db.commit()
    return result


class TeamLinkIn(BaseModel):
    team_id: int
    other_team_id: int
    kind: TeamLinkKind = TeamLinkKind.RELATED
    note: Optional[str] = None


@router.post("/team-links")
def team_link_create(body: TeamLinkIn, db: Session = DB):
    if body.team_id == body.other_team_id:
        raise HTTPException(422, "A team can't link to itself")
    found(db.get(Team, body.team_id), "Team not found")
    found(db.get(Team, body.other_team_id), "Team not found")
    link = TeamLink(**body.model_dump(), source=Source.CURATED)
    db.add(link)
    db.commit()
    return {"id": link.id}


@router.delete("/team-links/{link_id}")
def team_link_delete(link_id: int, db: Session = DB):
    db.delete(found(db.get(TeamLink, link_id), "Link not found"))
    db.commit()
    return {"deleted": link_id}


# ── Taxonomy ────────────────────────────────────────────────────────────────

class UniverseIn(BaseModel):
    name: str
    publisher_id: Optional[int] = None
    kind: UniverseKind = UniverseKind.ALTERNATE
    designation: Optional[str] = None
    description: Optional[str] = None


@router.post("/universes")
def universe_create(body: UniverseIn, db: Session = DB):
    slug = slugify(body.name)
    if db.scalar(select(Universe.id).where(Universe.slug == slug)):
        raise HTTPException(409, "A universe with that name exists")
    u = Universe(**body.model_dump(), slug=slug, sort_order=300)
    db.add(u)
    db.flush()
    u.eras.append(Era(name="All years", slug="all-years", start_date=date(1900, 1, 1)))
    db.commit()
    return {"id": u.id, "slug": u.slug}


class UniversePatch(BaseModel):
    name: Optional[str] = None
    kind: Optional[UniverseKind] = None
    designation: Optional[str] = None
    description: Optional[str] = None


@router.patch("/universes/{universe_id}")
def universe_update(universe_id: int, body: UniversePatch, db: Session = DB):
    u = found(db.get(Universe, universe_id), "Universe not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(u, key, value)
    db.commit()
    return {"id": u.id}


class EraIn(BaseModel):
    universe_id: int
    name: str
    start_date: date
    end_date: Optional[date] = None
    description: Optional[str] = None


@router.post("/eras")
def era_create(body: EraIn, db: Session = DB):
    found(db.get(Universe, body.universe_id), "Universe not found")
    era = Era(**body.model_dump(), slug=slugify(body.name))
    db.add(era)
    db.commit()
    return {"id": era.id}


class EraPatch(BaseModel):
    name: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = None


@router.patch("/eras/{era_id}")
def era_update(era_id: int, body: EraPatch, db: Session = DB):
    era = found(db.get(Era, era_id), "Era not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(era, key, value)
    if body.name:
        era.slug = slugify(body.name)
    db.commit()
    return {"id": era.id}


@router.delete("/eras/{era_id}")
def era_delete(era_id: int, db: Session = DB):
    db.delete(found(db.get(Era, era_id), "Era not found"))
    db.commit()
    return {"deleted": era_id}


class SeriesUniverses(BaseModel):
    universe_ids: List[int]


@router.put("/series/{series_id}/universes")
def series_universes(series_id: int, body: SeriesUniverses, db: Session = DB):
    """Curated universe assignment for a series (overrides Metron and the rules)."""
    found(db.get(Series, series_id), "Series not found")
    db.execute(delete(SeriesUniverse).where(SeriesUniverse.series_id == series_id))
    for uid in dict.fromkeys(body.universe_ids):
        found(db.get(Universe, uid), f"Universe {uid} not found")
        db.add(SeriesUniverse(series_id=series_id, universe_id=uid, source=Source.CURATED))
    db.commit()
    return {"series_id": series_id, "universe_ids": body.universe_ids}
