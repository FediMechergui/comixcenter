"""
Starter curation: well-known "read before" and "leads into" links between major arcs and events.
Applied on request to arcs already in the catalog (matched by name and year), so the
prerequisite graph has something to show before a curator builds the rest.
"""
from typing import Any, Dict, List, Optional, Tuple

from rapidfuzz import fuzz
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from comix.models import Arc, ArcIssue, ArcLink, ArcLinkKind, Issue, Source

# (arc, year) requires (arc, year)
PREREQUISITES: List[Tuple[Tuple[str, int], Tuple[str, int], str]] = [
    (("House of M", 2005), ("Avengers Disassembled", 2004), "Scarlet Witch's breakdown sets up House of M."),
    (("Secret Invasion", 2008), ("Civil War", 2006), "The post-Civil War split frames the Skrull invasion."),
    (("Dark Reign", 2009), ("Secret Invasion", 2008), "Norman Osborn's rise comes out of Secret Invasion."),
    (("Siege", 2010), ("Dark Reign", 2009), "Siege ends Dark Reign."),
    (("Time Runs Out", 2015), ("Infinity", 2013), "Hickman's Avengers saga continues."),
    (("Secret Wars", 2015), ("Time Runs Out", 2015), "The incursions end in Secret Wars."),
    (("Messiah War", 2009), ("Messiah Complex", 2007), "Cable and Hope on the run."),
    (("Second Coming", 2010), ("Messiah War", 2009), "Hope returns."),
    (("X of Swords", 2020), ("House of X / Powers of X", 2019), "Krakoa's founding."),
    (("Inferno", 2021), ("House of X / Powers of X", 2019), "Moira's secrets from HoX/PoX."),
    (("Infinite Crisis", 2005), ("Identity Crisis", 2004), "The mind-wipe fallout drives Infinite Crisis."),
    (("Infinite Crisis", 2005), ("Villains United", 2005), "Countdown to Infinite Crisis lead-in."),
    (("Infinite Crisis", 2005), ("The OMAC Project", 2005), "Countdown to Infinite Crisis lead-in."),
    (("Infinite Crisis", 2005), ("Day of Vengeance", 2005), "Countdown to Infinite Crisis lead-in."),
    (("Infinite Crisis", 2005), ("Rann-Thanagar War", 2005), "Countdown to Infinite Crisis lead-in."),
    (("Sinestro Corps War", 2007), ("Green Lantern: Rebirth", 2004), "Hal Jordan's return and Parallax."),
    (("Blackest Night", 2009), ("Sinestro Corps War", 2007), "The emotional spectrum and the Black Lanterns' prophecy."),
    (("Brightest Day", 2010), ("Blackest Night", 2009), "Picks up the resurrected heroes."),
    (("Dark Nights: Death Metal", 2020), ("Dark Nights: Metal", 2017), "Direct sequel."),
]

LEADS_INTO: List[Tuple[Tuple[str, int], Tuple[str, int], str]] = [
    (("The Death of Superman", 1992), ("Funeral for a Friend", 1993), ""),
    (("Funeral for a Friend", 1993), ("Reign of the Supermen", 1993), ""),
    (("Knightfall", 1993), ("Knightquest", 1993), ""),
    (("Knightquest", 1993), ("KnightsEnd", 1994), ""),
    (("Messiah Complex", 2007), ("Messiah War", 2009), ""),
    (("Blackest Night", 2009), ("Brightest Day", 2010), ""),
    (("Civil War", 2006), ("The Initiative", 2007), ""),
]


def find_arc(session: Session, name: str, year: int) -> Optional[Arc]:
    """Closest arc by name, breaking ties (e.g. 1984 vs 2015 Secret Wars) by first-issue year."""
    first = select(ArcIssue.arc_id, func.min(Issue.cover_date).label("first")).join(Issue, Issue.id == ArcIssue.issue_id) \
        .group_by(ArcIssue.arc_id).subquery()
    best, best_score = None, 0.0
    for arc, first_date in session.execute(select(Arc, first.c.first).join(first, first.c.arc_id == Arc.id, isouter=True)):
        score = fuzz.token_sort_ratio(name.lower(), arc.name.lower())
        if score < 88:
            continue
        if first_date:
            score -= min(abs(first_date.year - year), 10) * 2
        if score > best_score:
            best, best_score = arc, score
    return best


def apply_starter_pack(session: Session) -> Dict[str, Any]:
    added, unresolved = 0, []
    for links, kind in ((PREREQUISITES, ArcLinkKind.PREREQUISITE), (LEADS_INTO, ArcLinkKind.LEADS_INTO)):
        for (a_name, a_year), (b_name, b_year), note in links:
            a, b = find_arc(session, a_name, a_year), find_arc(session, b_name, b_year)
            if not a or not b:
                unresolved.append({"kind": kind.value, "from": f"{a_name} ({a_year})", "to": f"{b_name} ({b_year})",
                                   "missing": [n for n, x in ((a_name, a), (b_name, b)) if x is None]})
                continue
            exists = session.scalar(select(ArcLink.id).where(ArcLink.arc_id == a.id, ArcLink.target_arc_id == b.id,
                                                             ArcLink.kind == kind))
            if not exists and a.id != b.id:
                session.add(ArcLink(arc_id=a.id, target_arc_id=b.id, kind=kind, note=note or None, source=Source.STARTER))
                added += 1
    session.flush()
    return {"added": added, "unresolved": unresolved}


def starter_arc_names() -> List[Dict[str, Any]]:
    """Every arc the pack refers to, so the admin UI can offer to sync them from Metron."""
    names = {}
    for links in (PREREQUISITES, LEADS_INTO):
        for a, b, _ in links:
            names[a] = names[b] = True
    return [{"name": n, "year": y} for n, y in sorted(names)]
