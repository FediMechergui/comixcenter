"""
Curated universe / era taxonomy and the rules that place series into universes.

Universe classification is the first-class concept of the catalog. Metron tags many issues
with universes; where it doesn't, the rules below (imprint, title patterns, publisher default)
decide. Era boundaries are approximate cover dates and are editable through the admin API.
"""
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from comix.models import (
    Era, Imprint, Issue, IssueUniverse, Publisher, Series, SeriesUniverse, Source, Universe, UniverseKind,
)
from comix.parsing import detect_publisher


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


@dataclass(frozen=True)
class EraSeed:
    name: str
    start: date
    end: Optional[date]
    description: str = ""


@dataclass(frozen=True)
class UniverseSeed:
    slug: str
    name: str
    publisher: Optional[str]          # publisher slug, None for cross-publisher categories
    kind: UniverseKind
    designation: Optional[str] = None
    description: str = ""
    aliases: Tuple[str, ...] = ()     # names/designations Metron may use
    eras: Tuple[EraSeed, ...] = ()


def D(y: int, m: int = 1, d: int = 1) -> date:
    return date(y, m, d)


PUBLISHERS: Sequence[Tuple[str, str, Tuple[str, ...]]] = (
    # slug, display name, aliases used by Metron / Comic Vine
    ("marvel", "Marvel", ("Marvel Comics", "Marvel")),
    ("dc", "DC", ("DC Comics", "DC")),
    ("image", "Image", ("Image", "Image Comics")),
    ("dark-horse", "Dark Horse", ("Dark Horse Comics", "Dark Horse")),
    ("idw", "IDW", ("IDW Publishing", "IDW")),
    ("boom", "BOOM!", ("BOOM! Studios", "Boom! Studios", "BOOM!")),
    ("valiant", "Valiant", ("Valiant", "Valiant Comics", "Valiant Entertainment")),
    ("dynamite", "Dynamite", ("Dynamite Entertainment", "Dynamite")),
)


def _single_era(start: date, end: Optional[date] = None, name: str = "All years") -> Tuple[EraSeed, ...]:
    return (EraSeed(name, start, end),)


UNIVERSES: Sequence[UniverseSeed] = (
    # ── Marvel ──
    UniverseSeed("earth-616", "Earth-616", "marvel", UniverseKind.CONTINUITY, "Earth-616",
                 "Marvel's main continuity.", ("Earth 616", "Marvel Universe", "Earth-616"), (
        EraSeed("Golden Age (Timely & Atlas)", D(1939, 10), D(1961, 7, 31)),
        EraSeed("Silver Age", D(1961, 8), D(1970, 12, 31), "From Fantastic Four #1."),
        EraSeed("Bronze Age", D(1971, 1), D(1985, 12, 31)),
        EraSeed("Modern Age", D(1986, 1), D(2004, 7, 31)),
        EraSeed("Disassembled to Siege", D(2004, 8), D(2010, 5, 31),
                "Avengers Disassembled, House of M, Civil War, Secret Invasion, Dark Reign, Siege."),
        EraSeed("Heroic Age", D(2010, 6), D(2012, 9, 30)),
        EraSeed("Marvel NOW!", D(2012, 10), D(2015, 9, 30)),
        EraSeed("All-New, All-Different", D(2015, 10), D(2018, 5, 31), "Includes Marvel Legacy."),
        EraSeed("Fresh Start", D(2018, 6), D(2024, 6, 30), "Includes the Krakoa era of the X-Men."),
        EraSeed("From the Ashes and beyond", D(2024, 7), None),
    )),
    UniverseSeed("earth-1610", "Ultimate Universe (Earth-1610)", "marvel", UniverseKind.ALTERNATE, "Earth-1610",
                 "The original Ultimate Marvel line.", ("Earth 1610", "Ultimate Marvel", "Earth-1610"), (
        EraSeed("Ultimate Marvel", D(2000, 10), D(2009, 8, 31)),
        EraSeed("Ultimatum and Ultimate Comics", D(2009, 9), D(2015, 12, 31)),
    )),
    UniverseSeed("earth-6160", "Ultimate Universe (Earth-6160)", "marvel", UniverseKind.ALTERNATE, "Earth-6160",
                 "The 2023 Ultimate Universe built by the Maker.", ("Earth 6160", "Earth-6160", "New Ultimate"),
                 _single_era(D(2023, 11), name="New Ultimates")),
    UniverseSeed("earth-928", "Marvel 2099 (Earth-928)", "marvel", UniverseKind.ALTERNATE, "Earth-928",
                 "", ("Earth 928", "Earth-928", "Marvel 2099"), (
        EraSeed("Original 2099 line", D(1992, 11), D(1998, 12, 31)),
        EraSeed("2099 revivals", D(1999, 1), None),
    )),
    UniverseSeed("earth-982", "MC2 (Earth-982)", "marvel", UniverseKind.ALTERNATE, "Earth-982",
                 "Spider-Girl, A-Next and the MC2 line.", ("Earth 982", "Earth-982", "MC2"),
                 _single_era(D(1998, 10))),
    UniverseSeed("marvel-max", "MAX", "marvel", UniverseKind.LINE, None,
                 "Marvel's mature-readers line.", ("MAX",), _single_era(D(2001, 9))),
    UniverseSeed("what-if", "What If", "marvel", UniverseKind.ALTERNATE, None,
                 "One-shot alternate realities.", ("What If",), _single_era(D(1977, 2))),
    UniverseSeed("marvel-knights", "Marvel Knights", "marvel", UniverseKind.LINE, None,
                 "Marvel Knights line (mostly set in Earth-616).", ("Marvel Knights",), _single_era(D(1998, 11))),

    # ── DC ──
    UniverseSeed("dc-prime", "DC Prime Continuity", "dc", UniverseKind.CONTINUITY, "Prime Earth",
                 "DC's main continuity, through each reboot.",
                 ("Prime Earth", "New Earth", "Earth-0", "Earth 0", "Earth-1", "Earth One", "DC Universe"), (
        EraSeed("Golden Age", D(1938, 6), D(1956, 9, 30), "From Action Comics #1. Part of Pre-Crisis."),
        EraSeed("Silver Age", D(1956, 10), D(1970, 12, 31), "From Showcase #4. Part of Pre-Crisis."),
        EraSeed("Bronze Age (Pre-Crisis)", D(1971, 1), D(1985, 3, 31), "Ends with Crisis on Infinite Earths."),
        EraSeed("Post-Crisis", D(1985, 4), D(2011, 9, 30)),
        EraSeed("New 52", D(2011, 10), D(2016, 6, 30), "After Flashpoint."),
        EraSeed("Rebirth", D(2016, 7), D(2021, 2, 28)),
        EraSeed("Infinite Frontier", D(2021, 3), D(2023, 1, 31)),
        EraSeed("Dawn of DC", D(2023, 2), D(2024, 9, 30)),
        EraSeed("All In", D(2024, 10), None),
    )),
    UniverseSeed("dc-absolute", "Absolute Universe", "dc", UniverseKind.ALTERNATE, "Earth-Alpha",
                 "The All In Absolute line.", ("Earth-Alpha", "Earth Alpha", "Absolute Universe"),
                 _single_era(D(2024, 10), name="All In")),
    UniverseSeed("dc-elseworlds", "Elseworlds", "dc", UniverseKind.LINE, None,
                 "Out-of-continuity stories.", ("Elseworlds",), _single_era(D(1989, 1))),
    UniverseSeed("dc-black-label", "Black Label", "dc", UniverseKind.LINE, None,
                 "DC's prestige mature line.", ("Black Label", "DC Black Label"), _single_era(D(2018, 9))),
    UniverseSeed("vertigo", "Vertigo", "dc", UniverseKind.LINE, None,
                 "DC's mature imprint.", ("Vertigo",), _single_era(D(1993, 3), D(2020, 1, 31))),

    # ── Independents ──
    UniverseSeed("spawn-verse", "Spawn-verse", "image", UniverseKind.CONTINUITY, None,
                 "Todd McFarlane's shared Spawn universe.", ("Spawn Universe",), _single_era(D(1992, 5))),
    UniverseSeed("energon-universe", "Energon Universe", "image", UniverseKind.CONTINUITY, None,
                 "Skybound's shared Transformers / G.I. Joe universe.", ("Energon Universe",),
                 _single_era(D(2023, 6))),
    UniverseSeed("massive-verse", "Massive-Verse", "image", UniverseKind.CONTINUITY, None,
                 "Radiant Black and its shared universe.", ("Massive-Verse", "Massiveverse"),
                 _single_era(D(2021, 1))),
    UniverseSeed("invincible-universe", "Invincible Universe", "image", UniverseKind.CONTINUITY, None,
                 "", ("Invincible Universe",), _single_era(D(2003, 1))),
    UniverseSeed("mignolaverse", "Mignolaverse", "dark-horse", UniverseKind.CONTINUITY, None,
                 "Hellboy, B.P.R.D. and related series.", ("Hellboy Universe", "Mignolaverse"),
                 _single_era(D(1994, 3))),
    UniverseSeed("valiant-universe", "Valiant Universe", "valiant", UniverseKind.CONTINUITY, None,
                 "", ("Valiant Universe",), (
        EraSeed("Classic Valiant", D(1991, 5), D(1996, 12, 31)),
        EraSeed("Acclaim", D(1997, 1), D(2004, 12, 31)),
        EraSeed("Valiant Entertainment", D(2012, 5), None),
    )),

    # ── Cross-publisher categories ──
    UniverseSeed("standalone", "Standalone", None, UniverseKind.STANDALONE, None,
                 "Self-contained books you can read with no prior knowledge.", (), _single_era(D(1900, 1))),
    UniverseSeed("intercompany", "Intercompany", None, UniverseKind.INTERCOMPANY, None,
                 "Crossovers between publishers, tagged with both universes.", (), _single_era(D(1900, 1))),
)

# Publisher → default universe for series no other rule claims
DEFAULT_UNIVERSE = {"marvel": "earth-616", "dc": "dc-prime", "valiant": "valiant-universe"}

STANDALONE_TITLES = {norm(t) for t in (
    "Watchmen", "Saga", "Kingdom Come", "The Dark Knight Returns", "Batman: The Dark Knight Returns",
    "Maus", "Paper Girls", "Y: The Last Man", "Preacher", "V for Vendetta", "Sandman", "The Sandman",
    "Marvels", "Superman: Red Son", "All-Star Superman", "Transmetropolitan",
)}

AMALGAM_TITLES = {norm(t) for t in (
    "Amazon", "Assassins", "Bruce Wayne: Agent of S.H.I.E.L.D.", "Bullets & Bracelets", "Doctor Strangefate",
    "JLX", "Legends of the Dark Claw", "Magneto and the Magnetic Men", "Speed Demon", "Spider-Boy",
    "Super-Soldier", "X-Patrol", "Challengers of the Fantastic", "Dark Claw Adventures", "Generation Hex",
    "Iron Lantern", "JLX Unleashed", "Lobo the Duck", "Spider-Boy Team-Up", "Super-Soldier: Man of War",
    "The Exciting X-Patrol", "Thorion of the New Asgods", "DC Versus Marvel", "Marvel Versus DC",
    "DC/Marvel: All Access", "Unlimited Access",
)}

MC2_PREFIXES = ("spider-girl", "a-next", "j2", "fantastic five", "last hero standing", "last planet standing",
                "avengers next", "amazing spider-girl", "spectacular spider-girl", "wild thing")

TITLE_RULES: Sequence[Tuple[str, str, Optional[str]]] = (
    # regex on the lowercase series name, universe slug, required publisher slug
    (r"^(king |gunslinger |the )?spawn\b|^curse of the spawn|^sam and twitch|^the scorched|^spawn[:']", "spawn-verse", "image"),
    (r"^(transformers|void rivals|g\.?i\.? joe|destro|duke|cobra commander|energon universe)\b", "energon-universe", "image"),
    (r"^(radiant (black|red|pink)|rogue sun|inferno girl red|the dead lucky|supermassive|massive-verse)", "massive-verse", "image"),
    (r"^(invincible|guarding the globe|invincible universe|brit|capes)\b", "invincible-universe", "image"),
    (r"^(hellboy|b\.?p\.?r\.?d|abe sapien|lobster johnson|witchfinder|sir edward grey|frankenstein underground)", "mignolaverse", "dark-horse"),
    (r"^what if\b", "what-if", "marvel"),
    (r"\b2099\b", "earth-928", "marvel"),
    (r"\belseworlds\b", "dc-elseworlds", "dc"),
    (r"\bmax\b$", "marvel-max", "marvel"),
)

IMPRINT_RULES = {
    "black label": ["dc-black-label"],
    "dc black label": ["dc-black-label"],
    "vertigo": ["vertigo"],
    "elseworlds": ["dc-elseworlds"],
    "max": ["marvel-max"],
    "marvel max": ["marvel-max"],
    "marvel knights": ["marvel-knights", "earth-616"],
}


def seed_taxonomy(session: Session) -> Dict[str, int]:
    """Insert publishers, universes and eras that don't exist yet. Safe to run repeatedly."""
    created = {"publishers": 0, "universes": 0, "eras": 0}
    publishers: Dict[str, Publisher] = {p.slug: p for p in session.scalars(select(Publisher))}
    for order, (slug, name, _aliases) in enumerate(PUBLISHERS):
        if slug not in publishers:
            publishers[slug] = Publisher(slug=slug, name=name, sort_order=order)
            session.add(publishers[slug])
            created["publishers"] += 1
    session.flush()

    universes = {u.slug: u for u in session.scalars(select(Universe))}
    for order, seed in enumerate(UNIVERSES):
        uni = universes.get(seed.slug)
        if uni is None:
            uni = Universe(slug=seed.slug, name=seed.name, kind=seed.kind, designation=seed.designation,
                           description=seed.description or None, sort_order=order,
                           publisher_id=publishers[seed.publisher].id if seed.publisher else None)
            session.add(uni)
            session.flush()
            created["universes"] += 1
        existing_eras = {e.slug for e in uni.eras}
        for era in seed.eras:
            if slugify(era.name) not in existing_eras:
                uni.eras.append(Era(name=era.name, slug=slugify(era.name), start_date=era.start,
                                    end_date=era.end, description=era.description or None))
                created["eras"] += 1
    session.flush()
    return created


def publisher_for_name(session: Session, name: Optional[str]) -> Optional[Publisher]:
    """Seeded publisher matching a Metron / Comic Vine publisher name."""
    if not name:
        return None
    key = norm(name)
    for slug, display, aliases in PUBLISHERS:
        if key in {norm(a) for a in aliases + (display,)}:
            return session.scalar(select(Publisher).where(Publisher.slug == slug))
    return None


def universe_for_metron(session: Session, metron_id: int, name: str, designation: Optional[str],
                        publisher: Optional[Publisher]) -> Universe:
    """Map a Metron universe onto a seeded one (by designation/name aliases), creating it if unknown."""
    uni = session.scalar(select(Universe).where(Universe.metron_id == metron_id))
    if uni:
        return uni
    keys = {norm(name), norm(designation or "")} - {""}
    for seed in UNIVERSES:
        if keys & {norm(a) for a in seed.aliases + (seed.name, seed.designation or "")} - {""}:
            uni = session.scalar(select(Universe).where(Universe.slug == seed.slug))
            if uni and uni.metron_id is None:
                uni.metron_id = metron_id
                return uni
    slug = slugify(f"{publisher.slug if publisher else 'x'}-{name}")
    uni = session.scalar(select(Universe).where(Universe.slug == slug))
    if uni is None:
        uni = Universe(slug=slug, name=name, designation=designation, kind=UniverseKind.ALTERNATE,
                       publisher_id=publisher.id if publisher else None, metron_id=metron_id, sort_order=500)
        session.add(uni)
        session.flush()
        start = date(1900, 1, 1)
        uni.eras.append(Era(name="All years", slug="all-years", start_date=start))
    else:
        uni.metron_id = metron_id
    return uni


def rule_universe_slugs(series_name: str, publisher_slug: Optional[str], imprint_name: Optional[str],
                        year_began: Optional[int]) -> List[str]:
    """Universe slugs for a series from imprint and title rules, falling back to the publisher default."""
    name = (series_name or "").strip()
    lower = name.lower()
    slugs: List[str] = []

    if imprint_name:
        slugs += IMPRINT_RULES.get(imprint_name.strip().lower(), [])

    key = norm(name)
    if key in STANDALONE_TITLES or norm(re.sub(r"^the\s+", "", lower)) in STANDALONE_TITLES:
        slugs.append("standalone")

    if publisher_slug == "dc" and lower.startswith("absolute ") and (year_began or 0) >= 2024:
        slugs.append("dc-absolute")
    if publisher_slug == "marvel" and lower.startswith("ultimate"):
        if year_began and year_began >= 2023:
            slugs.append("earth-6160")
        elif year_began and 2000 <= year_began <= 2015:
            slugs.append("earth-1610")
    if publisher_slug == "marvel" and lower.startswith(MC2_PREFIXES) and (year_began or 0) >= 1998:
        slugs.append("earth-982")
    for pattern, slug, pub in TITLE_RULES:
        if (pub is None or pub == publisher_slug) and re.search(pattern, lower):
            slugs.append(slug)

    # Intercompany: Amalgam titles, or "A/B" where the halves belong to different publishers
    if key in AMALGAM_TITLES and 1996 <= (year_began or 0) <= 1997:
        slugs += ["intercompany", "earth-616", "dc-prime"]
    elif "/" in name:
        sides = [s.strip() for s in name.split("/", 1)]
        pubs = {detect_publisher(s.lower()) for s in sides} - {"Independent"}
        if len(pubs) == 2:
            slugs.append("intercompany")
            for pub in pubs:
                default = DEFAULT_UNIVERSE.get(slugify(pub))
                if default:
                    slugs.append(default)

    # Lines (MAX, Black Label, ...) and alternates replace the main continuity;
    # Marvel Knights / intercompany explicitly include it above.
    if not slugs and publisher_slug in DEFAULT_UNIVERSE:
        slugs.append(DEFAULT_UNIVERSE[publisher_slug])
    return list(dict.fromkeys(slugs))


def assign_series_universes(session: Session, series: Series) -> List[Universe]:
    """
    Set a series' universes: Metron's issue-level universes when it has any,
    otherwise the imprint/title rules. Curated assignments are never touched.
    """
    existing = {su.universe_id: su for su in session.scalars(
        select(SeriesUniverse).where(SeriesUniverse.series_id == series.id))}
    metron_ids: Set[int] = set(session.scalars(
        select(IssueUniverse.universe_id).join(Issue, Issue.id == IssueUniverse.issue_id)
        .where(Issue.series_id == series.id)).all())

    if metron_ids:
        wanted, source = metron_ids, Source.METRON
    else:
        publisher_slug = series.publisher.slug if series.publisher else None
        imprint_name = series.imprint.name if series.imprint else None
        slugs = rule_universe_slugs(series.name, publisher_slug, imprint_name, series.year_began)
        wanted = set(session.scalars(select(Universe.id).where(Universe.slug.in_(slugs))).all()) if slugs else set()
        source = Source.RULE

    for uid, su in existing.items():
        if su.source == Source.CURATED:
            continue
        if uid not in wanted:
            session.delete(su)
        else:
            su.source = source   # e.g. a rule guess now confirmed by Metron
    for uid in wanted - set(existing):
        session.add(SeriesUniverse(series_id=series.id, universe_id=uid, source=source))
    session.flush()
    return list(session.scalars(select(Universe).join(SeriesUniverse).where(SeriesUniverse.series_id == series.id)))
