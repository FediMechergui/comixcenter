"""
Metron → catalog sync. Every function is an idempotent upsert keyed on Metron ids.

`api` is a mokkari Session (or any object with the same methods), so tests pass a fake.
Shallow syncs use list endpoints (one request per page); `sync_issue` fetches a single
issue's full record (credits, arcs, characters, teams, universes, reprints).
"""
from datetime import date
from typing import Any, Callable, Dict, Iterable, List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from comix.ingest.common import number_sort, split_mantle, url_or_none, utcnow
from comix.models import (
    Appearance, AppearanceRole, Arc, ArcIssue, Character, CollectedIssue, Creator, Credit, Identity,
    Imprint, Issue, IssueUniverse, OrderKind, Publisher, ReadingOrder, ReadingOrderEntry, Series,
    Source, Team, TeamAffiliation, TeamAppearance, Tier,
)
from comix.parsing import parse_comic_title
from comix.taxonomy import assign_series_universes, publisher_for_name, slugify, universe_for_metron

Progress = Optional[Callable[[str], None]]

COLLECTED_SERIES_TYPES = {"trade paperback", "hard cover", "hardcover", "omnibus", "graphic novel",
                          "digital chapter", "tpb"}


def _note(progress: Progress, message: str) -> None:
    if progress:
        progress(message)


# ── Publishers, imprints, universes ─────────────────────────────────────────

def upsert_publisher(session: Session, metron_id: Optional[int], name: Optional[str],
                     detail: Any = None) -> Optional[Publisher]:
    if not name and metron_id is None:
        return None
    pub = session.scalar(select(Publisher).where(Publisher.metron_id == metron_id)) if metron_id else None
    if pub is None:
        pub = publisher_for_name(session, name)
        if pub is None and name:
            slug = slugify(name)
            pub = session.scalar(select(Publisher).where(Publisher.slug == slug))
            if pub is None:
                pub = Publisher(name=name, slug=slug, sort_order=200)
                session.add(pub)
        if pub is not None and metron_id and pub.metron_id is None:
            pub.metron_id = metron_id
    if detail is not None:
        pub.description = detail.desc or pub.description
        pub.founded = detail.founded or pub.founded
        pub.country = detail.country or pub.country
        pub.image_url = url_or_none(detail.image) or pub.image_url
        pub.cv_id = detail.cv_id or pub.cv_id
        pub.gcd_id = detail.gcd_id or pub.gcd_id
    session.flush()
    return pub


def sync_publishers(session: Session, api: Any, progress: Progress = None) -> Dict[str, int]:
    count = 0
    for item in api.publishers_list():
        upsert_publisher(session, item.id, item.name)
        count += 1
    _note(progress, f"{count} publishers")
    return {"publishers": count}


def upsert_imprint(session: Session, metron_id: int, name: str, publisher: Optional[Publisher]) -> Imprint:
    imp = session.scalar(select(Imprint).where(Imprint.metron_id == metron_id))
    if imp is None:
        imp = Imprint(metron_id=metron_id, name=name, publisher_id=publisher.id if publisher else None)
        session.add(imp)
        session.flush()
    return imp


def ensure_universe(session: Session, api: Any, ref: Any):
    """Universe for a Metron universe reference, fetching its detail the first time we see it."""
    from comix.models import Universe
    uni = session.scalar(select(Universe).where(Universe.metron_id == ref.id))
    if uni is not None:
        return uni
    detail = api.universe(ref.id)
    publisher = upsert_publisher(session, detail.publisher.id, detail.publisher.name) if detail and detail.publisher else None
    uni = universe_for_metron(session, ref.id, detail.name if detail else ref.name,
                              getattr(detail, "designation", None) if detail else None, publisher)
    if detail and detail.desc and not uni.description:
        uni.description = detail.desc
    session.flush()
    return uni


# ── Series and issues ───────────────────────────────────────────────────────

def ensure_series_stub(session: Session, ref: Any, publisher_id: Optional[int] = None) -> Series:
    """Series from a Metron BasicSeries/IssueSeries reference (id, name, volume, year_began)."""
    series = session.scalar(select(Series).where(Series.metron_id == ref.id))
    if series is None:
        series = Series(metron_id=ref.id, name=ref.name, volume=getattr(ref, "volume", None),
                        year_began=getattr(ref, "year_began", None), publisher_id=publisher_id)
        session.add(series)
        session.flush()
    elif publisher_id and series.publisher_id is None:
        series.publisher_id = publisher_id
    return series


def _apply_base_issue(issue: Issue, item: Any) -> None:
    issue.number = item.number or issue.number or "?"
    issue.number_sort = number_sort(issue.number)
    issue.cover_date = item.cover_date or issue.cover_date
    issue.store_date = getattr(item, "store_date", None) or issue.store_date
    issue.image_url = url_or_none(getattr(item, "image", None)) or issue.image_url
    name = getattr(item, "issue_name", None)
    if name and not issue.title:
        # Metron's list endpoint names issues "Series (Year) #N"; keep only real titles
        if not name.lower().startswith((item.series.name.lower() if getattr(item, "series", None) else "\0")):
            issue.title = name


def upsert_issue_from_list(session: Session, item: Any, series: Optional[Series] = None) -> Issue:
    """Shallow upsert from a list endpoint item (BaseIssue / ReadingListIssue)."""
    if series is None:
        series = ensure_series_stub(session, item.series)
    issue = session.scalar(select(Issue).where(Issue.metron_id == item.id))
    if issue is None:
        issue = Issue(metron_id=item.id, series_id=series.id, number=item.number or "?")
        session.add(issue)
    elif issue.series_id != series.id:
        issue.series_id = series.id          # stub created from a reprint, now placed in its real series
    _apply_base_issue(issue, item)
    if getattr(item, "cv_id", None):
        issue.cv_id = item.cv_id
    issue.synced_at = utcnow()
    session.flush()
    return issue


def refresh_series_span(session: Session, series: Series) -> None:
    first, last, count = session.execute(
        select(func.min(Issue.cover_date), func.max(Issue.cover_date), func.count(Issue.id))
        .where(Issue.series_id == series.id)).one()
    series.first_cover_date, series.last_cover_date = first, last
    if not series.issue_count or count > series.issue_count:
        series.issue_count = count
    if not series.image_url:
        series.image_url = session.scalar(
            select(Issue.image_url).where(Issue.series_id == series.id, Issue.image_url.is_not(None))
            .order_by(Issue.number_sort).limit(1))


def sync_series(session: Session, api: Any, metron_id: int, progress: Progress = None) -> Dict[str, Any]:
    """Series record plus all of its issues (shallow). Returns the issue Metron ids for deep sync."""
    detail = api.series(metron_id)
    if detail is None:
        raise LookupError(f"Metron series {metron_id} not found")
    publisher = upsert_publisher(session, detail.publisher.id, detail.publisher.name) if detail.publisher else None
    series = session.scalar(select(Series).where(Series.metron_id == metron_id))
    if series is None:
        series = Series(metron_id=metron_id, name=detail.name)
        session.add(series)
    series.name = detail.name
    series.sort_name = detail.sort_name or None
    series.volume = detail.volume
    series.year_began = detail.year_began
    series.year_end = detail.year_end
    series.series_type = detail.series_type.name if detail.series_type else None
    series.status = detail.status or None
    series.description = detail.desc or series.description
    series.issue_count = detail.issue_count or series.issue_count
    series.cv_id = detail.cv_id or series.cv_id
    series.gcd_id = detail.gcd_id or series.gcd_id
    series.publisher_id = publisher.id if publisher else series.publisher_id
    if detail.imprint:
        series.imprint_id = upsert_imprint(session, detail.imprint.id, detail.imprint.name, publisher).id
    session.flush()

    issue_ids: List[int] = []
    for item in api.series_issues_list(metron_id):
        upsert_issue_from_list(session, item, series)
        issue_ids.append(item.id)
    series.synced_at = utcnow()
    refresh_series_span(session, series)
    universes = assign_series_universes(session, series)
    _note(progress, f"{series.name} ({series.year_began}): {len(issue_ids)} issues")
    return {"series_id": series.id, "issues": len(issue_ids), "issue_metron_ids": issue_ids,
            "universes": [u.slug for u in universes]}


def ensure_identity(session: Session, metron_id: int, name: str,
                    publisher_id: Optional[int] = None) -> Identity:
    """Identity for a Metron character reference, creating its mantle from the name."""
    ident = session.scalar(select(Identity).where(Identity.metron_id == metron_id))
    if ident is not None:
        return ident
    mantle_name, person = split_mantle(name)
    query = select(Character).where(func.lower(Character.name) == mantle_name.lower())
    if publisher_id:
        query = query.where((Character.publisher_id == publisher_id) | Character.publisher_id.is_(None))
    character = session.scalars(query.order_by(Character.id)).first()
    if character is None:
        character = Character(name=mantle_name, publisher_id=publisher_id)
        session.add(character)
        session.flush()
    ident = Identity(metron_id=metron_id, name=name, display_name=person, character_id=character.id,
                     publisher_id=publisher_id)
    session.add(ident)
    session.flush()
    return ident


def ensure_team(session: Session, metron_id: int, name: str, publisher_id: Optional[int] = None) -> Team:
    team = session.scalar(select(Team).where(Team.metron_id == metron_id))
    if team is None:
        team = Team(metron_id=metron_id, name=name, publisher_id=publisher_id)
        session.add(team)
        session.flush()
    return team


def ensure_arc(session: Session, metron_id: int, name: str, publisher_id: Optional[int] = None) -> Arc:
    arc = session.scalar(select(Arc).where(Arc.metron_id == metron_id))
    if arc is None:
        arc = Arc(metron_id=metron_id, name=name, publisher_id=publisher_id)
        session.add(arc)
        session.flush()
    return arc


def ensure_creator(session: Session, metron_id: int, name: str) -> Creator:
    creator = session.scalar(select(Creator).where(Creator.metron_id == metron_id))
    if creator is None:
        creator = Creator(metron_id=metron_id, name=name)
        session.add(creator)
        session.flush()
    return creator


def _derived_role(series_name: str, identity: Identity) -> AppearanceRole:
    """Main when the series is named after the mantle or person (e.g. Batman in "Detective Comics" is not)."""
    title = series_name.lower()
    names = {identity.character.name.lower(), identity.display_name.lower()}
    return AppearanceRole.MAIN if any(n and n in title for n in names) else AppearanceRole.SUPPORTING


def add_appearance(session: Session, issue: Issue, identity: Identity) -> None:
    app = session.get(Appearance, (issue.id, identity.id))
    if app is None:
        session.add(Appearance(issue_id=issue.id, identity_id=identity.id,
                               role=_derived_role(issue.series.name, identity), role_source=Source.DERIVED))


def _reprint_stub(session: Session, metron_id: int, text: str, publisher_id: Optional[int]) -> Issue:
    """Issue reprinted in a collection that we haven't synced yet; placed in a provisional series."""
    issue = session.scalar(select(Issue).where(Issue.metron_id == metron_id))
    if issue is not None:
        return issue
    parsed = parse_comic_title(text)
    name, year = parsed["series_name"], parsed["year"]
    series = session.scalar(select(Series).where(Series.metron_id.is_(None), Series.name == name,
                                                 Series.year_began.is_(year) if year is None else Series.year_began == year))
    if series is None:
        series = Series(name=name, year_began=year, publisher_id=publisher_id)
        session.add(series)
        session.flush()
    issue = Issue(metron_id=metron_id, series_id=series.id, number=parsed["issue_number"] or "?",
                  number_sort=number_sort(parsed["issue_number"]))
    session.add(issue)
    session.flush()
    return issue


def sync_issue(session: Session, api: Any, metron_id: int, progress: Progress = None) -> Dict[str, Any]:
    """Full issue record: description, credits, arcs, characters, teams, universes, reprints."""
    detail = api.issue(metron_id)
    if detail is None:
        raise LookupError(f"Metron issue {metron_id} not found")
    publisher = upsert_publisher(session, detail.publisher.id, detail.publisher.name) if detail.publisher else None
    pub_id = publisher.id if publisher else None
    series = ensure_series_stub(session, detail.series, pub_id)
    if detail.imprint and series.imprint_id is None:
        series.imprint_id = upsert_imprint(session, detail.imprint.id, detail.imprint.name, publisher).id
    if detail.series.series_type and not series.series_type:
        series.series_type = detail.series.series_type.name
    issue = upsert_issue_from_list(session, detail, series)
    titles = [t for t in (detail.story_titles or []) if t]
    issue.title = detail.collection_title or (", ".join(titles) if titles else None) or issue.title
    issue.description = detail.desc or issue.description
    issue.page_count = detail.page_count or issue.page_count
    issue.isbn = detail.isbn or issue.isbn
    issue.upc = detail.upc or issue.upc
    issue.cv_id = detail.cv_id or issue.cv_id
    issue.gcd_id = detail.gcd_id or issue.gcd_id

    for credit in detail.credits or []:
        creator = ensure_creator(session, credit.id, credit.creator)
        for role in credit.role or []:
            exists = session.scalar(select(Credit.id).where(Credit.issue_id == issue.id,
                                                            Credit.creator_id == creator.id, Credit.role == role.name))
            if not exists:
                session.add(Credit(issue_id=issue.id, creator_id=creator.id, role=role.name))

    for ref in detail.arcs or []:
        arc = ensure_arc(session, ref.id, ref.name, pub_id)
        if arc.publisher_id is None:
            arc.publisher_id = pub_id
        if session.get(ArcIssue, (arc.id, issue.id)) is None:
            session.add(ArcIssue(arc_id=arc.id, issue_id=issue.id))

    new_identities, new_teams = [], []
    for ref in detail.characters or []:
        known = session.scalar(select(Identity.id).where(Identity.metron_id == ref.id))
        identity = ensure_identity(session, ref.id, ref.name, pub_id)
        if not known:
            new_identities.append(identity.id)
        add_appearance(session, issue, identity)

    for ref in detail.teams or []:
        known = session.scalar(select(Team.id).where(Team.metron_id == ref.id))
        team = ensure_team(session, ref.id, ref.name, pub_id)
        if not known:
            new_teams.append(team.id)
        if session.get(TeamAppearance, (issue.id, team.id)) is None:
            session.add(TeamAppearance(issue_id=issue.id, team_id=team.id))

    for ref in detail.universes or []:
        uni = ensure_universe(session, api, ref)
        if session.get(IssueUniverse, (issue.id, uni.id)) is None:
            session.add(IssueUniverse(issue_id=issue.id, universe_id=uni.id))

    for reprint in detail.reprints or []:
        original = _reprint_stub(session, reprint.id, reprint.issue, pub_id)
        if original.id != issue.id and session.get(CollectedIssue, (issue.id, original.id)) is None:
            session.add(CollectedIssue(collection_issue_id=issue.id, issue_id=original.id))

    issue.deep_synced_at = utcnow()
    session.flush()
    refresh_series_span(session, series)
    if detail.universes:
        assign_series_universes(session, series)
    _note(progress, f"{series.name} #{issue.number}")
    return {"issue_id": issue.id, "new_identity_ids": new_identities, "new_team_ids": new_teams}


# ── Arcs, characters, teams ─────────────────────────────────────────────────

def sync_arc(session: Session, api: Any, metron_id: int, progress: Progress = None) -> Dict[str, Any]:
    detail = api.arc(metron_id)
    if detail is None:
        raise LookupError(f"Metron arc {metron_id} not found")
    arc = ensure_arc(session, metron_id, detail.name)
    arc.name = detail.name
    arc.description = detail.desc or arc.description
    arc.image_url = url_or_none(detail.image) or arc.image_url
    arc.cv_id = detail.cv_id or arc.cv_id
    issue_ids = []
    for position, item in enumerate(api.arc_issues_list(metron_id)):
        issue = upsert_issue_from_list(session, item)
        link = session.get(ArcIssue, (arc.id, issue.id))
        if link is None:
            session.add(ArcIssue(arc_id=arc.id, issue_id=issue.id, position=position))
        else:
            link.position = position
        issue_ids.append(item.id)
        if arc.publisher_id is None and issue.series.publisher_id:
            arc.publisher_id = issue.series.publisher_id
    arc.synced_at = utcnow()
    session.flush()
    _note(progress, f"{arc.name}: {len(issue_ids)} issues")
    return {"arc_id": arc.id, "issues": len(issue_ids), "issue_metron_ids": issue_ids}


def sync_character(session: Session, api: Any, metron_id: int, with_issues: bool = True,
                   progress: Progress = None) -> Dict[str, Any]:
    detail = api.character(metron_id)
    if detail is None:
        raise LookupError(f"Metron character {metron_id} not found")
    identity = ensure_identity(session, metron_id, detail.name)
    identity.aliases = list(detail.alias or []) or identity.aliases
    identity.description = detail.desc or identity.description
    identity.image_url = url_or_none(detail.image) or identity.image_url
    identity.cv_id = detail.cv_id or identity.cv_id
    character = identity.character
    if not character.image_url:
        character.image_url = identity.image_url
    if not character.description and character.name == identity.name:
        character.description = identity.description
    for ref in detail.teams or []:
        team = ensure_team(session, ref.id, ref.name, identity.publisher_id)
        if session.get(TeamAffiliation, (identity.id, team.id)) is None:
            session.add(TeamAffiliation(identity_id=identity.id, team_id=team.id, source=Source.METRON))
    count = 0
    if with_issues:
        for item in api.character_issues_list(metron_id):
            issue = upsert_issue_from_list(session, item)
            if identity.publisher_id is None and issue.series.publisher_id:
                identity.publisher_id = issue.series.publisher_id
            add_appearance(session, issue, identity)
            count += 1
    identity.synced_at = utcnow()
    session.flush()
    _note(progress, f"{identity.name}: {count} appearances")
    return {"identity_id": identity.id, "character_id": identity.character_id, "appearances": count}


def sync_team(session: Session, api: Any, metron_id: int, with_issues: bool = True,
              progress: Progress = None) -> Dict[str, Any]:
    detail = api.team(metron_id)
    if detail is None:
        raise LookupError(f"Metron team {metron_id} not found")
    team = ensure_team(session, metron_id, detail.name)
    team.name = detail.name
    team.description = detail.desc or team.description
    team.image_url = url_or_none(detail.image) or team.image_url
    team.cv_id = detail.cv_id or team.cv_id
    count = 0
    if with_issues:
        for item in api.team_issues_list(metron_id):
            issue = upsert_issue_from_list(session, item)
            if team.publisher_id is None and issue.series.publisher_id:
                team.publisher_id = issue.series.publisher_id
            if session.get(TeamAppearance, (issue.id, team.id)) is None:
                session.add(TeamAppearance(issue_id=issue.id, team_id=team.id))
            count += 1
    team.synced_at = utcnow()
    session.flush()
    _note(progress, f"{team.name}: {count} appearances")
    return {"team_id": team.id, "appearances": count}


# ── Reading lists ───────────────────────────────────────────────────────────

def tier_for_reading_list_type(issue_type: Optional[str]) -> Tier:
    kind = (issue_type or "").lower()
    if "core" in kind or "main" in kind:
        return Tier.ESSENTIAL
    if "tie" in kind or "crossover" in kind:
        return Tier.TIE_IN
    if "optional" in kind or "extra" in kind:
        return Tier.OPTIONAL
    return Tier.RECOMMENDED


def sync_reading_list(session: Session, api: Any, metron_id: int, progress: Progress = None) -> Dict[str, Any]:
    """Imports a Metron community reading list as a reading order (source = metron)."""
    detail = api.reading_list(metron_id)
    if detail is None:
        raise LookupError(f"Metron reading list {metron_id} not found")
    order = session.scalar(select(ReadingOrder).where(ReadingOrder.metron_reading_list_id == metron_id))
    if order is None:
        slug = slugify(detail.name)
        if session.scalar(select(ReadingOrder.id).where(ReadingOrder.slug == slug)):
            slug = f"{slug}-metron-{metron_id}"
        order = ReadingOrder(name=detail.name, slug=slug, kind=OrderKind.CUSTOM, source=Source.METRON,
                             metron_reading_list_id=metron_id)
        session.add(order)
    order.name = detail.name
    attribution = f"\n\nSource: {detail.attribution_source}" if getattr(detail, "attribution_source", None) else ""
    order.description = ((detail.desc or "") + attribution).strip() or None
    session.flush()
    order.entries.clear()
    session.flush()
    items = sorted(api.reading_list_items(metron_id), key=lambda i: (i.order is None, i.order or 0))
    for position, item in enumerate(items):
        issue = upsert_issue_from_list(session, item.issue)
        order.entries.append(ReadingOrderEntry(position=position, issue_id=issue.id,
                                               tier=tier_for_reading_list_type(item.issue_type)))
    session.flush()
    _note(progress, f"{order.name}: {len(items)} entries")
    return {"order_id": order.id, "entries": len(items)}


# ── Search (admin "find on Metron") ─────────────────────────────────────────

def search(api: Any, kind: str, query: str, year: Optional[int] = None) -> List[Dict[str, Any]]:
    params: Dict[str, Any] = {"name": query}
    if kind == "series":
        if year:
            params["year_began"] = year
        return [{"metron_id": s.id, "name": s.display_name, "year_began": s.year_began,
                 "issue_count": s.issue_count, "publisher": s.publisher.name if s.publisher else None,
                 "series_type": s.series_type.name if s.series_type else None}
                for s in api.series_list(params)]
    listing = {"arc": api.arcs_list, "character": api.characters_list, "team": api.teams_list,
               "reading_list": api.reading_lists_list}.get(kind)
    if listing is None:
        raise ValueError(f"Unknown search kind {kind!r}")
    return [{"metron_id": r.id, "name": r.name} for r in listing(params)]
