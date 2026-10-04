"""
Story arcs, events, tiered reading orders, the prerequisite graph, and read progress.

Tiers let a reader pick a path through the same order:
  essential → only Essential          ("the 200-issue path")
  core      → Essential + Recommended
  complete  → everything except Skip   ("the 2,000-issue path")
  all       → everything, Skip included
Progress is per issue, so an issue read anywhere shows as read in every order containing it.
"""
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.orm import Session

from comix.bootstrap import DEFAULT_USER_ID
from comix.models import (
    Appearance, Arc, ArcIssue, ArcIssueRole, ArcKind, ArcLink, ArcLinkKind, Character, CharacterEvent,
    CharacterEventKind, CollectedIssue, Credit, Creator, EntryPrerequisite, Era, Identity, Issue, OrderKind,
    ReadingOrder, ReadingOrderEntry, ReadStatus, Series, SeriesUniverse, Source, Team, TeamAppearance, Tier,
    TIER_ORDER, Universe,
)
from comix.services.catalog import COLLECTED_TYPES, era_overlap, issue_cards, read_issue_ids, series_card
from comix.taxonomy import slugify

PATHS: Dict[str, Sequence[Tier]] = {
    "essential": (Tier.ESSENTIAL,),
    "core": (Tier.ESSENTIAL, Tier.RECOMMENDED),
    "complete": (Tier.ESSENTIAL, Tier.RECOMMENDED, Tier.TIE_IN, Tier.OPTIONAL),
    "all": tuple(TIER_ORDER),
}


def arc_issues(session: Session, arc_id: int) -> List[Issue]:
    return list(session.scalars(select(Issue).join(ArcIssue, ArcIssue.issue_id == Issue.id)
                                .where(ArcIssue.arc_id == arc_id)
                                .order_by(ArcIssue.position, Issue.cover_date, Issue.number_sort)))


def arc_summary(session: Session, arc: Arc, user_id: int = DEFAULT_USER_ID) -> Dict[str, Any]:
    span = session.execute(select(func.count(), func.min(Issue.cover_date), func.max(Issue.cover_date))
                           .join(ArcIssue, ArcIssue.issue_id == Issue.id).where(ArcIssue.arc_id == arc.id)).one()
    read = session.scalar(select(func.count()).select_from(ReadStatus).join(
        ArcIssue, and_(ArcIssue.issue_id == ReadStatus.issue_id, ArcIssue.arc_id == arc.id))
        .where(ReadStatus.user_id == user_id))
    return {"id": arc.id, "name": arc.name, "kind": arc.kind.value, "image_url": arc.image_url,
            "issue_count": span[0], "read_count": read, "start_date": span[1], "end_date": span[2]}


# ── Arcs and events ─────────────────────────────────────────────────────────

def list_arcs(session: Session, q: Optional[str] = None, kind: Optional[str] = None,
              publisher_id: Optional[int] = None, page: int = 1, size: int = 50) -> Dict[str, Any]:
    query = select(Arc)
    if q:
        query = query.where(Arc.name.ilike(f"%{q.strip()}%"))
    if kind:
        query = query.where(Arc.kind == kind)
    if publisher_id:
        query = query.where(Arc.publisher_id == publisher_id)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    first_date = select(func.min(Issue.cover_date)).join(ArcIssue, ArcIssue.issue_id == Issue.id) \
        .where(ArcIssue.arc_id == Arc.id).scalar_subquery()
    rows = session.scalars(query.order_by(first_date.desc().nulls_last(), Arc.name)
                           .offset((max(page, 1) - 1) * size).limit(size)).all()
    return {"items": [arc_summary(session, a) for a in rows], "total": total, "page": page, "size": size}


def arc_detail(session: Session, arc_id: int, user_id: int = DEFAULT_USER_ID) -> Optional[Dict[str, Any]]:
    arc = session.get(Arc, arc_id)
    if arc is None:
        return None
    links = session.execute(select(ArcIssue, Issue).join(Issue, Issue.id == ArcIssue.issue_id)
                            .where(ArcIssue.arc_id == arc.id)
                            .order_by(ArcIssue.position, Issue.cover_date, Issue.number_sort)).all()
    cards = {c["id"]: c for c in issue_cards(session, [i for _, i in links])}
    core, tie_ins = [], []
    for link, issue in links:
        card = dict(cards[issue.id], role=link.role.value, tier=link.tier.value if link.tier else None,
                    position=link.position)
        (core if link.role == ArcIssueRole.CORE else tie_ins).append(card)

    # Creators: everyone credited across the arc, writers and artists first
    creators = session.execute(
        select(Creator.id, Creator.name, Credit.role, func.count())
        .join(Credit, Credit.creator_id == Creator.id).join(ArcIssue, ArcIssue.issue_id == Credit.issue_id)
        .where(ArcIssue.arc_id == arc.id).group_by(Creator.id, Credit.role).order_by(func.count().desc())).all()
    by_role: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for cid, name, role, count in creators:
        by_role[role].append({"id": cid, "name": name, "issues": count})
    role_rank = lambda r: (0 if "writer" in r.lower() else 1 if any(k in r.lower() for k in ("artist", "pencil")) else 2, r)

    # Collected editions: collections reprinting any of the arc's issues, best coverage first
    collections = session.execute(
        select(Issue, func.count(CollectedIssue.issue_id))
        .join(CollectedIssue, CollectedIssue.collection_issue_id == Issue.id)
        .join(ArcIssue, and_(ArcIssue.issue_id == CollectedIssue.issue_id, ArcIssue.arc_id == arc.id))
        .group_by(Issue.id).order_by(func.count(CollectedIssue.issue_id).desc())).all()

    def linked(kind: ArcLinkKind, outgoing: bool) -> List[Dict[str, Any]]:
        col_from, col_to = (ArcLink.arc_id, ArcLink.target_arc_id) if outgoing else (ArcLink.target_arc_id, ArcLink.arc_id)
        rows = session.execute(select(Arc, ArcLink).join(ArcLink, col_to == Arc.id)
                               .where(col_from == arc.id, ArcLink.kind == kind)).all()
        return [dict(arc_summary(session, a, user_id), note=l.note, source=l.source.value, link_id=l.id) for a, l in rows]

    orders = session.execute(select(ReadingOrder.id, ReadingOrder.name, ReadingOrderEntry.tier)
                             .join(ReadingOrderEntry, ReadingOrderEntry.order_id == ReadingOrder.id)
                             .where(ReadingOrderEntry.arc_id == arc.id)).all()
    summary = arc_summary(session, arc, user_id)
    summary.update({
        "description": arc.description, "metron_id": arc.metron_id, "cv_id": arc.cv_id,
        "core_issues": core, "tie_ins": tie_ins,
        "creators": [{"role": r, "creators": by_role[r][:6]} for r in sorted(by_role, key=role_rank)],
        "collected_editions": [{"issue_id": c.id, "title": f"{c.series.name}" + (f" #{c.number}" if c.number not in ("1", "?") else ""),
                                "series_type": c.series.series_type, "image_url": c.image_url,
                                "covers": n, "of": len(links)} for c, n in collections],
        "prerequisites": linked(ArcLinkKind.PREREQUISITE, True),
        "required_by": linked(ArcLinkKind.PREREQUISITE, False),
        "leads_into": linked(ArcLinkKind.LEADS_INTO, True),
        "follows": linked(ArcLinkKind.LEADS_INTO, False),
        "continues_in": _next_in_series(session, arc, user_id),
        "reading_orders": [{"id": oid, "name": n, "tier": t.value} for oid, n, t in orders],
    })
    return summary


def _next_in_series(session: Session, arc: Arc, user_id: int) -> List[Dict[str, Any]]:
    """Derived suggestion: the next arc in the same series after this one ends."""
    last = session.execute(select(Issue.series_id, func.max(Issue.cover_date)).join(ArcIssue, ArcIssue.issue_id == Issue.id)
                           .where(ArcIssue.arc_id == arc.id).group_by(Issue.series_id)).all()
    out = []
    for series_id, end in last:
        if end is None:
            continue
        nxt = session.scalar(
            select(Arc).join(ArcIssue, ArcIssue.arc_id == Arc.id).join(Issue, Issue.id == ArcIssue.issue_id)
            .where(Issue.series_id == series_id, Arc.id != arc.id).group_by(Arc.id)
            .having(func.min(Issue.cover_date) > end).order_by(func.min(Issue.cover_date)).limit(1))
        if nxt and nxt.id not in {o["id"] for o in out}:
            out.append(arc_summary(session, nxt, user_id))
    return out


# ── Prerequisite graph ──────────────────────────────────────────────────────

PREREQ_CTE = """
WITH RECURSIVE prereq(arc_id, depth, needed_by) AS (
    SELECT target_arc_id, 1, arc_id FROM arc_links WHERE arc_id = :arc_id AND kind = 'prerequisite'
    UNION
    SELECT l.target_arc_id, p.depth + 1, l.arc_id
    FROM arc_links l JOIN prereq p ON l.arc_id = p.arc_id
    WHERE l.kind = 'prerequisite' AND p.depth < :max_depth
)
SELECT arc_id, MAX(depth) AS depth FROM prereq WHERE arc_id != :arc_id GROUP BY arc_id
"""


def prerequisite_plan(session: Session, arc_id: int, user_id: int = DEFAULT_USER_ID,
                      max_depth: int = 25) -> Optional[Dict[str, Any]]:
    """
    "What do I need before X?" Every arc reachable through prerequisite links, in a valid reading
    sequence (deepest prerequisites first, then by publication date), plus the edges for drawing.
    """
    target = session.get(Arc, arc_id)
    if target is None:
        return None
    rows = session.execute(text(PREREQ_CTE), {"arc_id": arc_id, "max_depth": max_depth}).all()
    depth = {r.arc_id: r.depth for r in rows}
    arcs = {a.id: a for a in session.scalars(select(Arc).where(Arc.id.in_(depth or {-1})))}
    summaries = {aid: arc_summary(session, a, user_id) for aid, a in arcs.items()}
    nodes = set(depth) | {arc_id}
    edges = session.execute(select(ArcLink.arc_id, ArcLink.target_arc_id, ArcLink.note).where(
        ArcLink.kind == ArcLinkKind.PREREQUISITE, ArcLink.arc_id.in_(nodes), ArcLink.target_arc_id.in_(nodes))).all()
    sequence = sorted(summaries.values(), key=lambda s: (-depth[s["id"]], s["start_date"] or datetime.max.date(), s["name"]))
    for s in sequence:
        s["depth"] = depth[s["id"]]
        s["done"] = s["issue_count"] > 0 and s["read_count"] >= s["issue_count"]
    remaining = [s for s in sequence if not s["done"]]
    return {
        "target": arc_summary(session, target, user_id),
        "sequence": sequence,
        "edges": [{"from": a, "to": b, "note": n} for a, b, n in edges],   # from needs to
        "remaining_arcs": len(remaining),
        "remaining_issues": sum(s["issue_count"] - s["read_count"] for s in remaining),
    }


def would_create_cycle(session: Session, arc_id: int, requires_arc_id: int) -> bool:
    """Adding arc → requires would be circular if `requires` already (transitively) needs `arc`."""
    if arc_id == requires_arc_id:
        return True
    reachable = {r.arc_id for r in session.execute(text(PREREQ_CTE), {"arc_id": requires_arc_id, "max_depth": 50})}
    return arc_id in reachable


# ── Reading orders ──────────────────────────────────────────────────────────

def _entry_issue_ids(session: Session, entries: Iterable[ReadingOrderEntry]) -> Dict[int, List[int]]:
    """Issue ids each entry stands for (an arc entry covers all its issues)."""
    out: Dict[int, List[int]] = {}
    arc_ids = {e.arc_id for e in entries if e.arc_id}
    arc_map: Dict[int, List[int]] = defaultdict(list)
    if arc_ids:
        for aid, iid in session.execute(select(ArcIssue.arc_id, ArcIssue.issue_id).join(Issue, Issue.id == ArcIssue.issue_id)
                                        .where(ArcIssue.arc_id.in_(arc_ids))
                                        .order_by(ArcIssue.position, Issue.cover_date, Issue.number_sort)):
            arc_map[aid].append(iid)
    for e in entries:
        out[e.id] = [e.issue_id] if e.issue_id else arc_map.get(e.arc_id, [])
    return out


def order_progress(session: Session, order: ReadingOrder, user_id: int = DEFAULT_USER_ID) -> Dict[str, Any]:
    entries = list(order.entries)
    covered = _entry_issue_ids(session, entries)
    read = read_issue_ids(session, sorted({i for ids in covered.values() for i in ids}), user_id)
    per_path = {}
    for path, tiers in PATHS.items():
        ids = {i for e in entries if e.tier in tiers for i in covered[e.id]}
        per_path[path] = {"issues": len(ids), "read": len(ids & read)}
    return {"entries": len(entries), "paths": per_path}


def order_card(session: Session, order: ReadingOrder, user_id: int = DEFAULT_USER_ID) -> Dict[str, Any]:
    progress = order_progress(session, order, user_id)
    return {"id": order.id, "name": order.name, "slug": order.slug, "kind": order.kind.value,
            "source": order.source.value, "description": order.description,
            "universe_id": order.universe_id, "era_id": order.era_id, "character_id": order.character_id,
            "team_id": order.team_id, "arc_id": order.arc_id, "creator_id": order.creator_id,
            "updated_at": order.updated_at, "progress": progress}


def list_orders(session: Session, kind: Optional[str] = None, universe_id: Optional[int] = None,
                character_id: Optional[int] = None, team_id: Optional[int] = None, arc_id: Optional[int] = None,
                creator_id: Optional[int] = None, q: Optional[str] = None) -> List[Dict[str, Any]]:
    query = select(ReadingOrder)
    for column, value in ((ReadingOrder.kind, kind), (ReadingOrder.universe_id, universe_id),
                          (ReadingOrder.character_id, character_id), (ReadingOrder.team_id, team_id),
                          (ReadingOrder.arc_id, arc_id), (ReadingOrder.creator_id, creator_id)):
        if value is not None:
            query = query.where(column == value)
    if q:
        query = query.where(ReadingOrder.name.ilike(f"%{q}%"))
    return [order_card(session, o) for o in session.scalars(query.order_by(ReadingOrder.name))]


def order_detail(session: Session, order_id: int, path: str = "core", user_id: int = DEFAULT_USER_ID) -> Optional[Dict[str, Any]]:
    order = session.get(ReadingOrder, order_id)
    if order is None:
        return None
    tiers = PATHS.get(path, PATHS["core"])
    entries = list(order.entries)
    covered = _entry_issue_ids(session, entries)
    all_issue_ids = sorted({i for ids in covered.values() for i in ids})
    read = read_issue_ids(session, all_issue_ids, user_id)
    issues = {i.id: i for i in session.scalars(select(Issue).where(Issue.id.in_(all_issue_ids or [-1])))}
    cards = {c["id"]: c for c in issue_cards(session, list(issues.values()))}
    arcs = {a.id: a for a in session.scalars(select(Arc).where(Arc.id.in_({e.arc_id for e in entries if e.arc_id} or {-1})))}
    arc_prereqs: Dict[int, List[int]] = defaultdict(list)
    for a, t in session.execute(select(ArcLink.arc_id, ArcLink.target_arc_id).where(
            ArcLink.kind == ArcLinkKind.PREREQUISITE, ArcLink.arc_id.in_(arcs or {-1}))):
        arc_prereqs[a].append(t)

    out_entries = []
    for e in entries:
        if e.tier not in tiers:
            continue
        ids = covered[e.id]
        item: Dict[str, Any] = {"id": e.id, "position": e.position, "tier": e.tier.value, "note": e.note,
                                "issue_count": len(ids), "read_count": len(set(ids) & read)}
        if e.issue_id:
            item.update(type="issue", issue=cards.get(e.issue_id))
        else:
            a = arcs[e.arc_id]
            item.update(type="arc", arc={"id": a.id, "name": a.name, "kind": a.kind.value, "image_url": a.image_url},
                        issues=[cards[i] for i in ids if i in cards])
        prereqs = [{"type": "arc", "id": p.requires_arc_id} if p.requires_arc_id else {"type": "issue", "id": p.requires_issue_id}
                   for p in e.prerequisites]
        prereqs += [{"type": "arc", "id": t} for t in arc_prereqs.get(e.arc_id, [])]
        if prereqs:
            names = dict(session.execute(select(Arc.id, Arc.name).where(Arc.id.in_([p["id"] for p in prereqs if p["type"] == "arc"] or [-1]))).all())
            for p in prereqs:
                p["name"] = names.get(p["id"]) if p["type"] == "arc" else (
                    f"{cards[p['id']]['series_name']} #{cards[p['id']]['number']}" if p["id"] in cards else None)
        item["prerequisites"] = prereqs
        item["done"] = item["issue_count"] > 0 and item["read_count"] >= item["issue_count"]
        out_entries.append(item)

    card = order_card(session, order, user_id)
    next_up = next((e for e in out_entries if not e["done"]), None)
    card.update({"path": path, "tiers": [t.value for t in tiers], "entries": out_entries,
                 "next_entry_id": next_up["id"] if next_up else None,
                 "tier_counts": {t.value: sum(1 for e in entries if e.tier == t) for t in TIER_ORDER}})
    return card


# ── Progress ────────────────────────────────────────────────────────────────

def set_read(session: Session, issue_ids: Iterable[int], read: bool, user_id: int = DEFAULT_USER_ID) -> int:
    ids = set(issue_ids)
    if not ids:
        return 0
    already = read_issue_ids(session, list(ids), user_id)
    if read:
        now = datetime.now(timezone.utc)
        for iid in ids - already:
            session.add(ReadStatus(user_id=user_id, issue_id=iid, read_at=now))
        changed = len(ids - already)
    else:
        session.execute(delete(ReadStatus).where(ReadStatus.user_id == user_id, ReadStatus.issue_id.in_(ids)))
        changed = len(already)
    session.flush()
    return changed


def mark_order_read_through(session: Session, order_id: int, entry_id: int, path: str = "core",
                            user_id: int = DEFAULT_USER_ID) -> int:
    """Marks every entry on the chosen path up to and including this one as read ("I've read up to here")."""
    order = session.get(ReadingOrder, order_id)
    tiers = PATHS.get(path, PATHS["core"])
    entries = [e for e in order.entries if e.tier in tiers]
    covered = _entry_issue_ids(session, entries)
    ids: List[int] = []
    for e in entries:
        ids += covered[e.id]
        if e.id == entry_id:
            break
    return set_read(session, ids, True, user_id)


def progress_summary(session: Session, user_id: int = DEFAULT_USER_ID, limit: int = 12) -> Dict[str, Any]:
    total = session.scalar(select(func.count()).select_from(ReadStatus).where(ReadStatus.user_id == user_id))
    recent = session.scalars(select(Issue).join(ReadStatus, ReadStatus.issue_id == Issue.id)
                             .where(ReadStatus.user_id == user_id).order_by(ReadStatus.read_at.desc()).limit(limit)).all()
    in_progress = []
    for order in session.scalars(select(ReadingOrder)):
        p = order_progress(session, order, user_id)["paths"]["core"]
        if 0 < p["read"] < p["issues"]:
            in_progress.append(dict(order_card(session, order, user_id)))
    in_progress.sort(key=lambda o: -o["progress"]["paths"]["core"]["read"] / max(o["progress"]["paths"]["core"]["issues"], 1))
    return {"issues_read": total, "recent": issue_cards(session, list(recent)), "orders_in_progress": in_progress[:limit]}


# ── Generating draft orders for curation ────────────────────────────────────

def _unique_slug(session: Session, name: str) -> str:
    base = slugify(name) or "order"
    slug, n = base, 2
    while session.scalar(select(ReadingOrder.id).where(ReadingOrder.slug == slug)):
        slug, n = f"{base}-{n}", n + 1
    return slug


def _new_order(session: Session, name: str, kind: OrderKind, replace: bool, **refs: Any) -> ReadingOrder:
    """Reuses a generated order with the same subject when replacing; curated orders are never overwritten."""
    query = select(ReadingOrder).where(ReadingOrder.kind == kind, ReadingOrder.source == Source.GENERATED)
    for key, value in refs.items():
        query = query.where(getattr(ReadingOrder, key) == value if value is not None else getattr(ReadingOrder, key).is_(None))
    existing = session.scalar(query)
    if existing and replace:
        existing.entries.clear()
        session.flush()
        return existing
    order = ReadingOrder(name=name, slug=_unique_slug(session, name), kind=kind, source=Source.GENERATED, **refs)
    session.add(order)
    session.flush()
    return order


def _arcs_by_first_date(session: Session, arc_ids: Iterable[int]) -> List[Arc]:
    first = select(ArcIssue.arc_id, func.min(Issue.cover_date).label("first")).join(Issue, Issue.id == ArcIssue.issue_id) \
        .where(ArcIssue.arc_id.in_(set(arc_ids) or {-1})).group_by(ArcIssue.arc_id).subquery()
    return list(session.scalars(select(Arc).join(first, first.c.arc_id == Arc.id).order_by(first.c.first, Arc.name)))


def generate_event_order(session: Session, arc_id: int, replace: bool = True) -> ReadingOrder:
    """Event/arc → issue-level order: core issues Essential, tie-ins at their curated tier (default Tie-in)."""
    arc = session.get(Arc, arc_id)
    order = _new_order(session, f"{arc.name} reading order", OrderKind.EVENT, replace, arc_id=arc.id)
    order.description = f"Every issue of {arc.name} in reading order. Core issues are Essential; tie-ins are tiered."
    links = session.execute(select(ArcIssue).join(Issue, Issue.id == ArcIssue.issue_id).where(ArcIssue.arc_id == arc.id)
                            .order_by(ArcIssue.position, Issue.cover_date, Issue.number_sort)).scalars().all()
    for pos, link in enumerate(links):
        tier = Tier.ESSENTIAL if link.role == ArcIssueRole.CORE else (link.tier or Tier.TIE_IN)
        order.entries.append(ReadingOrderEntry(position=pos, issue_id=link.issue_id, tier=tier))
    session.flush()
    return order


def generate_character_order(session: Session, character_id: int, replace: bool = True) -> ReadingOrder:
    """
    Character → arc-level draft: arcs where the character appears in at least half the issues,
    their first appearance and deaths/resurrections as Essential issues, ordered by date.
    """
    character = session.get(Character, character_id)
    order = _new_order(session, f"{character.name} reading order", OrderKind.CHARACTER, replace, character_id=character.id)
    order.description = (f"Draft generated from {character.name}'s appearances: the arcs they anchor, plus key issues. "
                         "Curate tiers in the admin editor.")
    identity_ids = [i.id for i in character.identities]
    share = session.execute(text("""
        SELECT ai.arc_id, COUNT(DISTINCT ai.issue_id) AS total,
               COUNT(DISTINCT CASE WHEN ap.identity_id IS NOT NULL THEN ai.issue_id END) AS featured,
               SUM(CASE WHEN ap.role = 'main' THEN 1 ELSE 0 END) AS main
        FROM arc_issues ai LEFT JOIN appearances ap ON ap.issue_id = ai.issue_id
             AND ap.identity_id IN (SELECT id FROM identities WHERE character_id = :cid)
        GROUP BY ai.arc_id HAVING featured > 0
    """), {"cid": character.id}).all()
    keep = {r.arc_id: r for r in share if r.featured * 2 >= r.total}
    key_issues = {e.issue_id: e.kind for e in session.scalars(select(CharacterEvent).where(
        CharacterEvent.identity_id.in_(identity_ids or [-1]), CharacterEvent.issue_id.is_not(None),
        CharacterEvent.kind.in_([CharacterEventKind.FIRST_APPEARANCE, CharacterEventKind.DEATH, CharacterEventKind.RESURRECTION])))}
    items: List[tuple] = []
    for arc in _arcs_by_first_date(session, keep):
        start = session.scalar(select(func.min(Issue.cover_date)).join(ArcIssue).where(ArcIssue.arc_id == arc.id))
        r = keep[arc.id]
        tier = Tier.RECOMMENDED if (r.main or 0) * 2 >= r.total or arc.kind == ArcKind.EVENT else Tier.OPTIONAL
        items.append((start, "arc", arc.id, tier))
    for iid in key_issues:
        issue = session.get(Issue, iid)
        items.append((issue.cover_date, "issue", iid, Tier.ESSENTIAL))
    items.sort(key=lambda t: (t[0] or datetime.max.date()))
    for pos, (_, typ, ref, tier) in enumerate(items):
        order.entries.append(ReadingOrderEntry(position=pos, tier=tier, **({"arc_id": ref} if typ == "arc" else {"issue_id": ref})))
    session.flush()
    return order


def generate_team_order(session: Session, team_id: int, replace: bool = True) -> ReadingOrder:
    team = session.get(Team, team_id)
    order = _new_order(session, f"{team.name} reading order", OrderKind.TEAM, replace, team_id=team.id)
    order.description = f"Draft generated from {team.name}'s appearances: arcs the team anchors, by date."
    rows = session.execute(text("""
        SELECT ai.arc_id, COUNT(DISTINCT ai.issue_id) AS total, COUNT(DISTINCT ta.issue_id) AS featured
        FROM arc_issues ai LEFT JOIN team_appearances ta ON ta.issue_id = ai.issue_id AND ta.team_id = :tid
        GROUP BY ai.arc_id HAVING featured * 2 >= total AND featured > 0"""), {"tid": team.id}).all()
    for pos, arc in enumerate(_arcs_by_first_date(session, [r.arc_id for r in rows])):
        order.entries.append(ReadingOrderEntry(position=pos, arc_id=arc.id,
                                               tier=Tier.ESSENTIAL if arc.kind == ArcKind.EVENT else Tier.RECOMMENDED))
    session.flush()
    return order


def generate_writer_order(session: Session, creator_id: int, series_id: Optional[int] = None,
                          replace: bool = True) -> ReadingOrder:
    """A writer's run: every issue they wrote (optionally within one series), by cover date."""
    creator = session.get(Creator, creator_id)
    series = session.get(Series, series_id) if series_id else None
    name = f"{creator.name}'s {series.name} run" if series else f"{creator.name}: complete works"
    order = _new_order(session, name, OrderKind.WRITER, replace, creator_id=creator.id)
    query = select(Issue).join(Credit, Credit.issue_id == Issue.id).where(
        Credit.creator_id == creator.id, Credit.role.ilike("%writer%"))
    if series:
        query = query.where(Issue.series_id == series.id)
    issues = session.scalars(query.distinct().order_by(Issue.cover_date, Issue.number_sort)).all()
    for pos, issue in enumerate(issues):
        collected = (issue.series.series_type or "").lower() in COLLECTED_TYPES
        order.entries.append(ReadingOrderEntry(position=pos, issue_id=issue.id,
                                               tier=Tier.OPTIONAL if collected else Tier.RECOMMENDED))
    session.flush()
    return order


def generate_universe_order(session: Session, universe_id: int, era_id: Optional[int] = None,
                            replace: bool = True) -> ReadingOrder:
    """Master chronological order for a universe (optionally one era): its arcs and events by date."""
    universe = session.get(Universe, universe_id)
    era = session.get(Era, era_id) if era_id else None
    name = f"{universe.name}: {era.name}" if era else f"{universe.name}: master order"
    order = _new_order(session, name, OrderKind.UNIVERSE, replace, universe_id=universe.id, era_id=era.id if era else None)
    order.description = "Master chronological order of arcs and events, by first publication."
    query = select(ArcIssue.arc_id).join(Issue, Issue.id == ArcIssue.issue_id).join(
        SeriesUniverse, and_(SeriesUniverse.series_id == Issue.series_id, SeriesUniverse.universe_id == universe.id))
    if era:
        query = query.where(Issue.cover_date >= era.start_date)
        if era.end_date:
            query = query.where(Issue.cover_date <= era.end_date)
    for pos, arc in enumerate(_arcs_by_first_date(session, set(session.scalars(query.distinct())))):
        order.entries.append(ReadingOrderEntry(position=pos, arc_id=arc.id,
                                               tier=Tier.ESSENTIAL if arc.kind == ArcKind.EVENT else Tier.RECOMMENDED))
    session.flush()
    return order
