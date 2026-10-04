"""
Team rosters over time and the graphs between teams and characters.

Sources say *who* is on a team (TeamAffiliation, from Metron and Comic Vine) but not *when*.
Membership stints are derived from co-appearances: a member's stint runs from the first to the
last issue where both the member and the team appear. Curated memberships are never replaced.
"""
from collections import defaultdict
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, func, select, text
from sqlalchemy.orm import Session

from comix.models import (
    Appearance, Identity, Issue, Membership, Source, Team, TeamAffiliation, TeamAppearance, TeamLink,
)


def derive_memberships(session: Session, team_id: int) -> Dict[str, int]:
    team = session.get(Team, team_id)
    if team is None:
        raise LookupError(f"team {team_id} not found")
    member_ids = set(session.scalars(select(TeamAffiliation.identity_id).where(TeamAffiliation.team_id == team_id)))
    curated = set(session.scalars(select(Membership.identity_id).where(
        Membership.team_id == team_id, Membership.source == Source.CURATED)))

    rows = session.execute(
        select(Appearance.identity_id, func.min(Issue.cover_date), func.max(Issue.cover_date), func.count())
        .join(TeamAppearance, and_(TeamAppearance.issue_id == Appearance.issue_id, TeamAppearance.team_id == team_id))
        .join(Issue, Issue.id == Appearance.issue_id)
        .where(Appearance.identity_id.in_(member_ids or {-1}), Issue.cover_date.is_not(None))
        .group_by(Appearance.identity_id)).all()

    session.query(Membership).filter(Membership.team_id == team_id, Membership.source == Source.DERIVED).delete()
    created = 0
    spans = {identity_id: (first, last) for identity_id, first, last, _ in rows}
    for identity_id in member_ids - curated:
        first_issue = last_issue = None
        if identity_id in spans:
            first, last = spans[identity_id]
            first_issue = _co_appearance_issue(session, team_id, identity_id, first, earliest=True)
            last_issue = _co_appearance_issue(session, team_id, identity_id, last, earliest=False)
        session.add(Membership(team_id=team_id, identity_id=identity_id, from_issue_id=first_issue,
                               to_issue_id=last_issue, source=Source.DERIVED))
        created += 1
    session.flush()
    return {"team_id": team_id, "members": len(member_ids), "derived": created, "curated_kept": len(curated)}


def _co_appearance_issue(session: Session, team_id: int, identity_id: int, cover_date, earliest: bool) -> Optional[int]:
    order = (Issue.cover_date, Issue.number_sort) if earliest else (Issue.cover_date.desc(), Issue.number_sort.desc())
    return session.scalar(
        select(Issue.id)
        .join(Appearance, and_(Appearance.issue_id == Issue.id, Appearance.identity_id == identity_id))
        .join(TeamAppearance, and_(TeamAppearance.issue_id == Issue.id, TeamAppearance.team_id == team_id))
        .where(Issue.cover_date == cover_date).order_by(*order).limit(1))


def roster_timeline(session: Session, team_id: int) -> List[Dict[str, Any]]:
    """Memberships with their date span, earliest first, for the swimlane roster view."""
    rows = session.execute(text("""
        SELECT m.id, m.identity_id, i.display_name, i.name AS identity_name, c.id AS character_id,
               c.name AS character_name, i.image_url, m.source, m.note,
               fi.id AS from_issue_id, fi.cover_date AS from_date, fs.name || ' #' || fi.number AS from_label,
               ti.id AS to_issue_id, ti.cover_date AS to_date, ts.name || ' #' || ti.number AS to_label
        FROM memberships m
        JOIN identities i ON i.id = m.identity_id
        JOIN characters c ON c.id = i.character_id
        LEFT JOIN issues fi ON fi.id = m.from_issue_id LEFT JOIN series fs ON fs.id = fi.series_id
        LEFT JOIN issues ti ON ti.id = m.to_issue_id LEFT JOIN series ts ON ts.id = ti.series_id
        WHERE m.team_id = :team_id
        ORDER BY fi.cover_date IS NULL, fi.cover_date, i.display_name
    """), {"team_id": team_id}).mappings().all()
    return [dict(r) for r in rows]


def linked_teams(session: Session, team_id: int, limit: int = 20) -> List[Dict[str, Any]]:
    """Curated links (spin-offs, successors) plus teams that share members, strongest first."""
    links: Dict[int, Dict[str, Any]] = {}
    for link in session.scalars(select(TeamLink).where((TeamLink.team_id == team_id) | (TeamLink.other_team_id == team_id))):
        other = link.other_team_id if link.team_id == team_id else link.team_id
        links[other] = {"team_id": other, "kinds": [link.kind.value], "note": link.note, "shared_members": 0}

    shared = session.execute(text("""
        SELECT b.team_id AS other, COUNT(DISTINCT b.identity_id) AS shared
        FROM team_affiliations a JOIN team_affiliations b ON a.identity_id = b.identity_id AND b.team_id != a.team_id
        WHERE a.team_id = :team_id GROUP BY b.team_id ORDER BY shared DESC LIMIT :limit
    """), {"team_id": team_id, "limit": limit}).all()
    for other, count in shared:
        entry = links.setdefault(other, {"team_id": other, "kinds": [], "note": None, "shared_members": 0})
        entry["shared_members"] = count
        if "shared_members" not in entry["kinds"]:
            entry["kinds"].append("shared_members")
    names = dict(session.execute(select(Team.id, Team.name).where(Team.id.in_(links or {-1}))).all())
    images = dict(session.execute(select(Team.id, Team.image_url).where(Team.id.in_(links or {-1}))).all())
    result = []
    for entry in links.values():
        entry["name"] = names.get(entry["team_id"])
        entry["image_url"] = images.get(entry["team_id"])
        result.append(entry)
    return sorted(result, key=lambda e: (-len([k for k in e["kinds"] if k != "shared_members"]), -e["shared_members"]))[:limit]


def shared_team_history(session: Session, character_id: int, limit: int = 30) -> Dict[str, Any]:
    """
    Graph of characters who served on a team with this character (any of its identities):
    nodes are characters, edges list the teams they shared. Overlapping stints are preferred
    when dated memberships exist; otherwise shared affiliation is used.
    """
    rows = session.execute(text("""
        SELECT oc.id AS other_id, oc.name AS other_name, oc.image_url AS other_image,
               t.id AS team_id, t.name AS team_name
        FROM identities me
        JOIN team_affiliations ma ON ma.identity_id = me.id
        JOIN team_affiliations oa ON oa.team_id = ma.team_id AND oa.identity_id != ma.identity_id
        JOIN identities oi ON oi.id = oa.identity_id
        JOIN characters oc ON oc.id = oi.character_id AND oc.id != :cid
        JOIN teams t ON t.id = ma.team_id
        WHERE me.character_id = :cid
    """), {"cid": character_id}).mappings().all()
    edges: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        e = edges.setdefault(r["other_id"], {"character_id": r["other_id"], "name": r["other_name"],
                                             "image_url": r["other_image"], "teams": {}})
        e["teams"][r["team_id"]] = r["team_name"]
    ranked = sorted(edges.values(), key=lambda e: -len(e["teams"]))[:limit]
    for e in ranked:
        e["teams"] = [{"team_id": k, "name": v} for k, v in e["teams"].items()]
    return {"character_id": character_id, "links": ranked}
