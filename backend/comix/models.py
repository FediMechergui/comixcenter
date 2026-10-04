"""
Catalog data model (Spec 2):

  Publisher ─┬─ Universe/Continuity ─┬─ Era ── Series(Volume) ── Issue
             │                       │                            │
             └─ Imprint              └─ Event ─── Story Arc ──────┤
                                                                  │
  Character ─ Identity (Spider-Man → Peter / Miles / Miguel) ─────┤ appearances
  Team ── Membership(character, identity, from_issue, to_issue) ──┘
  ReadingOrder ── Entry(issue|arc, position, tier, note, prereqs[])

Universes attach to series and issues many-to-many, so intercompany crossovers carry both.
Eras are date ranges inside a universe; a series belongs to every era its run overlaps.
"""
from datetime import date, datetime, timezone
from enum import StrEnum
from typing import List, Optional

from sqlalchemy import (
    JSON, CheckConstraint, Date, DateTime, Enum, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


def _enum(cls):
    return Enum(cls, native_enum=False, validate_strings=True, length=24,
                values_callable=lambda e: [m.value for m in e])


class UniverseKind(StrEnum):
    CONTINUITY = "continuity"      # a shared continuity: Earth-616, DC Prime
    ALTERNATE = "alternate"        # parallel worlds: Ultimate, 2099, Absolute
    LINE = "line"                  # imprint lines outside main continuity: Black Label, MAX, Vertigo
    STANDALONE = "standalone"      # self-contained books
    INTERCOMPANY = "intercompany"  # crossovers between publishers


class ArcKind(StrEnum):
    ARC = "arc"
    EVENT = "event"


class ArcIssueRole(StrEnum):
    CORE = "core"
    TIE_IN = "tie_in"


class ArcLinkKind(StrEnum):
    PREREQUISITE = "prerequisite"  # arc requires target: read target first
    LEADS_INTO = "leads_into"      # arc's fallout continues in target


class Tier(StrEnum):
    ESSENTIAL = "essential"
    RECOMMENDED = "recommended"
    TIE_IN = "tie_in"
    OPTIONAL = "optional"
    SKIP = "skip"


TIER_ORDER = [Tier.ESSENTIAL, Tier.RECOMMENDED, Tier.TIE_IN, Tier.OPTIONAL, Tier.SKIP]


class OrderKind(StrEnum):
    UNIVERSE = "universe"
    CHARACTER = "character"
    TEAM = "team"
    EVENT = "event"
    WRITER = "writer"
    CUSTOM = "custom"


class Source(StrEnum):
    METRON = "metron"
    COMICVINE = "comicvine"
    RULE = "rule"
    DERIVED = "derived"
    CURATED = "curated"
    GENERATED = "generated"
    STARTER = "starter"


class AppearanceRole(StrEnum):
    MAIN = "main"
    SUPPORTING = "supporting"
    CAMEO = "cameo"


class CharacterEventKind(StrEnum):
    FIRST_APPEARANCE = "first_appearance"
    DEATH = "death"
    RESURRECTION = "resurrection"
    COSTUME = "costume"


class TeamLinkKind(StrEnum):
    SPINOFF = "spinoff"
    RELATED = "related"
    SUCCESSOR = "successor"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


# ── Taxonomy ────────────────────────────────────────────────────────────────

class Publisher(Base):
    __tablename__ = "publishers"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(200), unique=True)
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]] = mapped_column(index=True)
    gcd_id: Mapped[Optional[int]]
    founded: Mapped[Optional[int]]
    country: Mapped[Optional[str]] = mapped_column(String(8))
    description: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    sort_order: Mapped[int] = mapped_column(default=100)

    universes: Mapped[List["Universe"]] = relationship(back_populates="publisher")
    imprints: Mapped[List["Imprint"]] = relationship(back_populates="publisher")


class Imprint(Base):
    __tablename__ = "imprints"
    id: Mapped[int] = mapped_column(primary_key=True)
    publisher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("publishers.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(200))
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]]
    description: Mapped[Optional[str]] = mapped_column(Text)

    publisher: Mapped[Optional[Publisher]] = relationship(back_populates="imprints")


class Universe(Base):
    __tablename__ = "universes"
    id: Mapped[int] = mapped_column(primary_key=True)
    publisher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("publishers.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(200), unique=True)
    designation: Mapped[Optional[str]] = mapped_column(String(100))
    kind: Mapped[UniverseKind] = mapped_column(_enum(UniverseKind), default=UniverseKind.CONTINUITY)
    description: Mapped[Optional[str]] = mapped_column(Text)
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    sort_order: Mapped[int] = mapped_column(default=100)

    publisher: Mapped[Optional[Publisher]] = relationship(back_populates="universes")
    eras: Mapped[List["Era"]] = relationship(back_populates="universe", order_by="Era.start_date",
                                             cascade="all, delete-orphan")


class Era(Base):
    __tablename__ = "eras"
    __table_args__ = (UniqueConstraint("universe_id", "slug"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    universe_id: Mapped[int] = mapped_column(ForeignKey("universes.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(200))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[Optional[date]] = mapped_column(Date)  # None = ongoing
    description: Mapped[Optional[str]] = mapped_column(Text)

    universe: Mapped[Universe] = relationship(back_populates="eras")


# ── Catalog ─────────────────────────────────────────────────────────────────

class Series(Base):
    __tablename__ = "series"
    id: Mapped[int] = mapped_column(primary_key=True)
    publisher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("publishers.id", ondelete="SET NULL"), index=True)
    imprint_id: Mapped[Optional[int]] = mapped_column(ForeignKey("imprints.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(300), index=True)
    sort_name: Mapped[Optional[str]] = mapped_column(String(300))
    volume: Mapped[Optional[int]]
    year_began: Mapped[Optional[int]] = mapped_column(index=True)
    year_end: Mapped[Optional[int]]
    series_type: Mapped[Optional[str]] = mapped_column(String(80))
    status: Mapped[Optional[str]] = mapped_column(String(40))
    description: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    issue_count: Mapped[Optional[int]]
    # Cover-date span of the issues we hold; places the series in eras precisely
    first_cover_date: Mapped[Optional[date]] = mapped_column(Date)
    last_cover_date: Mapped[Optional[date]] = mapped_column(Date)
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]] = mapped_column(index=True)
    gcd_id: Mapped[Optional[int]]
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    publisher: Mapped[Optional[Publisher]] = relationship()
    imprint: Mapped[Optional[Imprint]] = relationship()
    issues: Mapped[List["Issue"]] = relationship(back_populates="series", order_by="Issue.number_sort")
    universes: Mapped[List[Universe]] = relationship(secondary="series_universes", viewonly=True)


class SeriesUniverse(Base):
    __tablename__ = "series_universes"
    series_id: Mapped[int] = mapped_column(ForeignKey("series.id", ondelete="CASCADE"), primary_key=True)
    universe_id: Mapped[int] = mapped_column(ForeignKey("universes.id", ondelete="CASCADE"), primary_key=True, index=True)
    source: Mapped[Source] = mapped_column(_enum(Source), default=Source.RULE)


class Issue(Base):
    __tablename__ = "issues"
    id: Mapped[int] = mapped_column(primary_key=True)
    series_id: Mapped[int] = mapped_column(ForeignKey("series.id", ondelete="CASCADE"), index=True)
    number: Mapped[str] = mapped_column(String(40))
    number_sort: Mapped[float] = mapped_column(Float, default=0.0)
    title: Mapped[Optional[str]] = mapped_column(String(500))
    cover_date: Mapped[Optional[date]] = mapped_column(Date, index=True)
    store_date: Mapped[Optional[date]] = mapped_column(Date)
    description: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    page_count: Mapped[Optional[int]]
    isbn: Mapped[Optional[str]] = mapped_column(String(40), index=True)
    upc: Mapped[Optional[str]] = mapped_column(String(40), index=True)
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]] = mapped_column(index=True)
    gcd_id: Mapped[Optional[int]]
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    deep_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cv_enriched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    series: Mapped[Series] = relationship(back_populates="issues")
    universes: Mapped[List[Universe]] = relationship(secondary="issue_universes", viewonly=True)


class IssueUniverse(Base):
    __tablename__ = "issue_universes"
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True)
    universe_id: Mapped[int] = mapped_column(ForeignKey("universes.id", ondelete="CASCADE"), primary_key=True, index=True)


class Creator(Base):
    __tablename__ = "creators"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]] = mapped_column(index=True)


class Credit(Base):
    __tablename__ = "credits"
    __table_args__ = (UniqueConstraint("issue_id", "creator_id", "role"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    creator_id: Mapped[int] = mapped_column(ForeignKey("creators.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(60))

    creator: Mapped[Creator] = relationship()


class CollectedIssue(Base):
    """A collected edition (TPB, omnibus, hardcover) and the single issues it reprints."""
    __tablename__ = "collected_issues"
    collection_issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True, index=True)


# ── Arcs and events ─────────────────────────────────────────────────────────

class Arc(Base):
    __tablename__ = "arcs"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300), index=True)
    kind: Mapped[ArcKind] = mapped_column(_enum(ArcKind), default=ArcKind.ARC)
    description: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    publisher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("publishers.id", ondelete="SET NULL"))
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]] = mapped_column(index=True)
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class ArcIssue(Base):
    __tablename__ = "arc_issues"
    arc_id: Mapped[int] = mapped_column(ForeignKey("arcs.id", ondelete="CASCADE"), primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True, index=True)
    position: Mapped[int] = mapped_column(default=0)
    role: Mapped[ArcIssueRole] = mapped_column(_enum(ArcIssueRole), default=ArcIssueRole.CORE)
    tier: Mapped[Optional[Tier]] = mapped_column(_enum(Tier))


class ArcLink(Base):
    __tablename__ = "arc_links"
    __table_args__ = (UniqueConstraint("arc_id", "target_arc_id", "kind"),
                      CheckConstraint("arc_id != target_arc_id"))
    id: Mapped[int] = mapped_column(primary_key=True)
    arc_id: Mapped[int] = mapped_column(ForeignKey("arcs.id", ondelete="CASCADE"), index=True)
    target_arc_id: Mapped[int] = mapped_column(ForeignKey("arcs.id", ondelete="CASCADE"), index=True)
    kind: Mapped[ArcLinkKind] = mapped_column(_enum(ArcLinkKind))
    note: Mapped[Optional[str]] = mapped_column(Text)
    source: Mapped[Source] = mapped_column(_enum(Source), default=Source.CURATED)


# ── Characters and teams ────────────────────────────────────────────────────

class Character(Base):
    """A mantle or persona, e.g. "Spider-Man". The people behind it are Identities."""
    __tablename__ = "characters"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    publisher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("publishers.id", ondelete="SET NULL"))

    identities: Mapped[List["Identity"]] = relationship(back_populates="character")


class Identity(Base):
    """
    One person behind a mantle (Peter Parker, Miles Morales). Each Metron / Comic Vine
    character record maps to one Identity; curators can regroup identities under mantles.
    """
    __tablename__ = "identities"
    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(String(200), index=True)       # source record name
    display_name: Mapped[str] = mapped_column(String(200))           # the person, e.g. "Miles Morales"
    real_name: Mapped[Optional[str]] = mapped_column(String(200))
    aliases: Mapped[Optional[List[str]]] = mapped_column(JSON)
    description: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    publisher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("publishers.id", ondelete="SET NULL"))
    first_appearance_issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"))
    first_appearance_text: Mapped[Optional[str]] = mapped_column(String(300))
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]] = mapped_column(index=True)
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cv_enriched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    character: Mapped[Character] = relationship(back_populates="identities")


class Appearance(Base):
    __tablename__ = "appearances"
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True)
    identity_id: Mapped[int] = mapped_column(ForeignKey("identities.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[Optional[AppearanceRole]] = mapped_column(_enum(AppearanceRole))
    role_source: Mapped[Source] = mapped_column(_enum(Source), default=Source.DERIVED)


class CharacterEvent(Base):
    """First appearance, death, resurrection, or a costume era (issue → end_issue)."""
    __tablename__ = "character_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    identity_id: Mapped[int] = mapped_column(ForeignKey("identities.id", ondelete="CASCADE"), index=True)
    kind: Mapped[CharacterEventKind] = mapped_column(_enum(CharacterEventKind))
    issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"))
    issue_text: Mapped[Optional[str]] = mapped_column(String(300))   # when the issue isn't in the catalog
    end_issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"))
    cv_issue_id: Mapped[Optional[int]]
    note: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    source: Mapped[Source] = mapped_column(_enum(Source), default=Source.CURATED)


class Team(Base):
    __tablename__ = "teams"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    image_url: Mapped[Optional[str]] = mapped_column(String(500))
    publisher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("publishers.id", ondelete="SET NULL"))
    first_appearance_issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"))
    first_appearance_text: Mapped[Optional[str]] = mapped_column(String(300))
    disbanded_text: Mapped[Optional[str]] = mapped_column(String(500))
    metron_id: Mapped[Optional[int]] = mapped_column(unique=True)
    cv_id: Mapped[Optional[int]] = mapped_column(index=True)
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    cv_enriched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class TeamAppearance(Base):
    __tablename__ = "team_appearances"
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True, index=True)


class TeamAffiliation(Base):
    """A source says this identity is a member of this team (no dates)."""
    __tablename__ = "team_affiliations"
    identity_id: Mapped[int] = mapped_column(ForeignKey("identities.id", ondelete="CASCADE"), primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True, index=True)
    source: Mapped[Source] = mapped_column(_enum(Source), default=Source.METRON)


class Membership(Base):
    """A dated stint on a team: from_issue → to_issue (None = still a member / unknown)."""
    __tablename__ = "memberships"
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    identity_id: Mapped[int] = mapped_column(ForeignKey("identities.id", ondelete="CASCADE"), index=True)
    from_issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"))
    to_issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"))
    note: Mapped[Optional[str]] = mapped_column(Text)
    source: Mapped[Source] = mapped_column(_enum(Source), default=Source.DERIVED)


class TeamLink(Base):
    __tablename__ = "team_links"
    __table_args__ = (UniqueConstraint("team_id", "other_team_id", "kind"),
                      CheckConstraint("team_id != other_team_id"))
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    other_team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    kind: Mapped[TeamLinkKind] = mapped_column(_enum(TeamLinkKind), default=TeamLinkKind.RELATED)
    note: Mapped[Optional[str]] = mapped_column(Text)
    source: Mapped[Source] = mapped_column(_enum(Source), default=Source.CURATED)


# ── Reading orders and progress ─────────────────────────────────────────────

class ReadingOrder(Base):
    __tablename__ = "reading_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    slug: Mapped[str] = mapped_column(String(300), unique=True)
    kind: Mapped[OrderKind] = mapped_column(_enum(OrderKind), default=OrderKind.CUSTOM)
    description: Mapped[Optional[str]] = mapped_column(Text)
    universe_id: Mapped[Optional[int]] = mapped_column(ForeignKey("universes.id", ondelete="SET NULL"))
    era_id: Mapped[Optional[int]] = mapped_column(ForeignKey("eras.id", ondelete="SET NULL"))
    character_id: Mapped[Optional[int]] = mapped_column(ForeignKey("characters.id", ondelete="SET NULL"))
    team_id: Mapped[Optional[int]] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"))
    arc_id: Mapped[Optional[int]] = mapped_column(ForeignKey("arcs.id", ondelete="SET NULL"))
    creator_id: Mapped[Optional[int]] = mapped_column(ForeignKey("creators.id", ondelete="SET NULL"))
    source: Mapped[Source] = mapped_column(_enum(Source), default=Source.CURATED)
    metron_reading_list_id: Mapped[Optional[int]] = mapped_column(unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    entries: Mapped[List["ReadingOrderEntry"]] = relationship(
        back_populates="order", order_by="ReadingOrderEntry.position", cascade="all, delete-orphan")


class ReadingOrderEntry(Base):
    __tablename__ = "reading_order_entries"
    __table_args__ = (CheckConstraint("(issue_id IS NULL) != (arc_id IS NULL)", name="entry_issue_xor_arc"),
                      Index("ix_entries_order_position", "order_id", "position"))
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("reading_orders.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(default=0)
    issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    arc_id: Mapped[Optional[int]] = mapped_column(ForeignKey("arcs.id", ondelete="CASCADE"), index=True)
    tier: Mapped[Tier] = mapped_column(_enum(Tier), default=Tier.RECOMMENDED)
    note: Mapped[Optional[str]] = mapped_column(Text)

    order: Mapped[ReadingOrder] = relationship(back_populates="entries")
    prerequisites: Mapped[List["EntryPrerequisite"]] = relationship(cascade="all, delete-orphan")


class EntryPrerequisite(Base):
    """Extra "read before" link on a single entry (arc-level links live in ArcLink)."""
    __tablename__ = "entry_prerequisites"
    __table_args__ = (CheckConstraint("(requires_issue_id IS NULL) != (requires_arc_id IS NULL)",
                                      name="prereq_issue_xor_arc"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("reading_order_entries.id", ondelete="CASCADE"), index=True)
    requires_issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"))
    requires_arc_id: Mapped[Optional[int]] = mapped_column(ForeignKey("arcs.id", ondelete="CASCADE"))
    note: Mapped[Optional[str]] = mapped_column(Text)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))


class ReadStatus(Base):
    """Per-issue read state: one row marks the issue read in every order that contains it."""
    __tablename__ = "read_status"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True, index=True)
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ── Library ─────────────────────────────────────────────────────────────────

class LibraryFile(Base):
    __tablename__ = "library_files"
    id: Mapped[int] = mapped_column(primary_key=True)
    path: Mapped[str] = mapped_column(String(1000), unique=True)  # absolute path on the server
    managed: Mapped[bool] = mapped_column(default=True)            # True: copied into the library dir
    original_name: Mapped[str] = mapped_column(String(500))
    format: Mapped[str] = mapped_column(String(10))
    size: Mapped[int] = mapped_column(default=0)
    sha256: Mapped[str] = mapped_column(String(64), unique=True)
    page_count: Mapped[int] = mapped_column(default=0)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    issue_id: Mapped[Optional[int]] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"), index=True)
    match_method: Mapped[Optional[str]] = mapped_column(String(40))
    match_confidence: Mapped[Optional[float]]
    comicinfo: Mapped[Optional[dict]] = mapped_column(JSON)
    parsed: Mapped[Optional[dict]] = mapped_column(JSON)            # series/number/year guessed from the name
    current_page: Mapped[int] = mapped_column(default=0)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    opds_feed_id: Mapped[Optional[int]] = mapped_column(ForeignKey("opds_feeds.id", ondelete="SET NULL"))

    issue: Mapped[Optional[Issue]] = relationship()


class PagePanels(Base):
    __tablename__ = "page_panels"
    file_id: Mapped[int] = mapped_column(ForeignKey("library_files.id", ondelete="CASCADE"), primary_key=True)
    page_index: Mapped[int] = mapped_column(primary_key=True)
    width: Mapped[int]
    height: Mapped[int]
    panels: Mapped[list] = mapped_column(JSON)   # [[x, y, w, h], ...] in reading order, 0..1 relative


class OpdsFeed(Base):
    __tablename__ = "opds_feeds"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    url: Mapped[str] = mapped_column(String(1000))
    username: Mapped[Optional[str]] = mapped_column(String(200))
    password: Mapped[Optional[str]] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ── Background jobs ─────────────────────────────────────────────────────────

class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_pick", "status", "priority", "id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(60))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    dedupe_key: Mapped[Optional[str]] = mapped_column(String(300), index=True)
    status: Mapped[JobStatus] = mapped_column(_enum(JobStatus), default=JobStatus.QUEUED)
    priority: Mapped[int] = mapped_column(default=100)   # lower runs first
    attempts: Mapped[int] = mapped_column(default=0)
    error: Mapped[Optional[str]] = mapped_column(Text)
    result: Mapped[Optional[dict]] = mapped_column(JSON)
    progress: Mapped[Optional[str]] = mapped_column(String(300))
    run_after: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))  # deferred (rate limits)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
