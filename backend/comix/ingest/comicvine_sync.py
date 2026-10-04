"""
Comic Vine enrichment for records already in the catalog (linked through the cv_id Metron provides):
real names and aliases, first appearances, deaths, team rosters, disbandings, story arc text.

`cv` is a simyan Comicvine client (or a fake with the same methods).
"""
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from comix.ingest.common import strip_html, utcnow
from comix.models import (
    Arc, CharacterEvent, CharacterEventKind, Identity, Issue, Source, Team, TeamAffiliation,
)


def _local_issue(session: Session, cv_issue_id: Optional[int]) -> Optional[Issue]:
    if not cv_issue_id:
        return None
    return session.scalar(select(Issue).where(Issue.cv_id == cv_issue_id))


def _issue_label(cv: Any, ref: Any) -> str:
    """"Amazing Fantasy #15" for a Comic Vine issue reference (fetches the issue for its volume name)."""
    number = getattr(ref, "number", None)
    try:
        full = cv.get_issue(ref.id)
        volume = full.volume.name if full.volume else None
        year = full.cover_date.year if full.cover_date else None
        number = number or full.number
        if volume:
            return f"{volume} #{number}" + (f" ({year})" if year else "")
    except Exception:
        pass
    return f"{ref.name or 'Issue'}" + (f" #{number}" if number else "")


def _upsert_event(session: Session, identity: Identity, kind: CharacterEventKind, cv_issue_id: int,
                  label: Optional[str]) -> CharacterEvent:
    event = session.scalar(select(CharacterEvent).where(
        CharacterEvent.identity_id == identity.id, CharacterEvent.kind == kind,
        CharacterEvent.cv_issue_id == cv_issue_id))
    local = _local_issue(session, cv_issue_id)
    if event is None:
        event = CharacterEvent(identity_id=identity.id, kind=kind, cv_issue_id=cv_issue_id, source=Source.COMICVINE)
        session.add(event)
    event.issue_id = local.id if local else event.issue_id
    event.issue_text = label or event.issue_text
    return event


def enrich_identity(session: Session, cv: Any, identity_id: int) -> Dict[str, Any]:
    identity = session.get(Identity, identity_id)
    if identity is None or not identity.cv_id:
        return {"skipped": "no Comic Vine id"}
    c = cv.get_character(identity.cv_id)
    identity.real_name = c.real_name or identity.real_name
    if c.aliases:
        extra = [a.strip() for a in c.aliases.splitlines() if a.strip()]
        identity.aliases = list(dict.fromkeys((identity.aliases or []) + extra))
    if not identity.description:
        identity.description = c.summary or strip_html(c.description)
    if not identity.image_url and c.image:
        identity.image_url = str(c.image.original_url)
    # A plain record like "Spider-Man" whose real name is Peter Parker: show the person
    if identity.display_name == identity.name and identity.real_name and identity.character.name == identity.name:
        identity.display_name = identity.real_name

    result: Dict[str, Any] = {"identity_id": identity.id}
    if c.first_issue:
        label = _issue_label(cv, c.first_issue)
        event = _upsert_event(session, identity, CharacterEventKind.FIRST_APPEARANCE, c.first_issue.id, label)
        identity.first_appearance_issue_id = event.issue_id
        identity.first_appearance_text = label
        result["first_appearance"] = label
        result["first_appearance_cv_issue_id"] = c.first_issue.id
    for death in c.deaths or []:
        _upsert_event(session, identity, CharacterEventKind.DEATH, death.id, death.name)
    result["deaths"] = len(c.deaths or [])

    for ref in c.teams or []:
        team = session.scalar(select(Team).where(Team.cv_id == ref.id))
        if team and session.get(TeamAffiliation, (identity.id, team.id)) is None:
            session.add(TeamAffiliation(identity_id=identity.id, team_id=team.id, source=Source.COMICVINE))
    identity.cv_enriched_at = utcnow()
    session.flush()
    return result


def enrich_team(session: Session, cv: Any, team_id: int) -> Dict[str, Any]:
    team = session.get(Team, team_id)
    if team is None or not team.cv_id:
        return {"skipped": "no Comic Vine id"}
    t = cv.get_team(team.cv_id)
    if not team.description:
        team.description = t.summary or strip_html(t.description)
    if not team.image_url and t.image:
        team.image_url = str(t.image.original_url)
    if t.first_issue:
        label = _issue_label(cv, t.first_issue)
        local = _local_issue(session, t.first_issue.id)
        team.first_appearance_issue_id = local.id if local else team.first_appearance_issue_id
        team.first_appearance_text = label
    if t.issues_disbanded_in:
        team.disbanded_text = ", ".join(i.name or f"Issue {i.id}" for i in t.issues_disbanded_in)[:500]
    members = 0
    for ref in t.members or []:
        identity = session.scalar(select(Identity).where(Identity.cv_id == ref.id))
        if identity is not None:
            members += 1
            if session.get(TeamAffiliation, (identity.id, team.id)) is None:
                session.add(TeamAffiliation(identity_id=identity.id, team_id=team.id, source=Source.COMICVINE))
    team.cv_enriched_at = utcnow()
    session.flush()
    return {"team_id": team.id, "members_matched": members, "members_listed": len(t.members or [])}


def enrich_arc(session: Session, cv: Any, arc_id: int) -> Dict[str, Any]:
    arc = session.get(Arc, arc_id)
    if arc is None or not arc.cv_id:
        return {"skipped": "no Comic Vine id"}
    a = cv.get_story_arc(arc.cv_id)
    if not arc.description:
        arc.description = strip_html(a.description) or a.summary
    if not arc.image_url and a.image:
        arc.image_url = str(a.image.original_url)
    session.flush()
    return {"arc_id": arc.id}


def enrich_issue(session: Session, cv: Any, issue_id: int) -> Dict[str, Any]:
    """First appearances and deaths recorded on a single issue."""
    issue = session.get(Issue, issue_id)
    if issue is None or not issue.cv_id:
        return {"skipped": "no Comic Vine id"}
    i = cv.get_issue(issue.cv_id)
    label = f"{issue.series.name} #{issue.number}" + (f" ({issue.cover_date.year})" if issue.cover_date else "")
    firsts = deaths = 0
    for ref in i.first_appearance_characters or []:
        identity = session.scalar(select(Identity).where(Identity.cv_id == ref.id))
        if identity is not None:
            _upsert_event(session, identity, CharacterEventKind.FIRST_APPEARANCE, issue.cv_id, label)
            if identity.first_appearance_issue_id is None:
                identity.first_appearance_issue_id = issue.id
                identity.first_appearance_text = label
            firsts += 1
    for ref in i.first_appearance_teams or []:
        team = session.scalar(select(Team).where(Team.cv_id == ref.id))
        if team is not None and team.first_appearance_issue_id is None:
            team.first_appearance_issue_id = issue.id
            team.first_appearance_text = label
    for ref in i.deaths or []:
        identity = session.scalar(select(Identity).where(Identity.cv_id == ref.id))
        if identity is not None:
            _upsert_event(session, identity, CharacterEventKind.DEATH, issue.cv_id, label)
            deaths += 1
    issue.cv_enriched_at = utcnow()
    session.flush()
    return {"issue_id": issue.id, "first_appearances": firsts, "deaths": deaths}
