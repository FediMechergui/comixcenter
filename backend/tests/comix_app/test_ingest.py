from sqlalchemy import func, select

from comix import db
from comix.ingest import comicvine_sync, jobs, metron_sync
from comix.ingest.common import number_sort, split_mantle
from comix.models import (
    Appearance, AppearanceRole, Arc, ArcIssue, Character, CharacterEvent, CharacterEventKind, CollectedIssue,
    Credit, Identity, Issue, Job, JobStatus, Membership, ReadingOrder, Series, SeriesUniverse, Team,
    TeamAffiliation, Tier, Universe,
)
from comix.services.teams import derive_memberships, linked_teams, roster_timeline, shared_team_history


def test_number_sort_and_mantles():
    assert number_sort("1") < number_sort("1.MU") < number_sort("2") < number_sort("10")
    assert number_sort("½") == 0.5 and number_sort("-1") == -1 and number_sort("Annual") == 1e9
    assert split_mantle("Spider-Man (Miles Morales)") == ("Spider-Man", "Miles Morales")
    assert split_mantle("Thor") == ("Thor", "Thor")
    assert split_mantle("Thor (Earth-1610)") == ("Thor (Earth-1610)", "Thor (Earth-1610)")


def test_sync_series_shallow_assigns_universe_and_span(session, metron):
    result = metron_sync.sync_series(session, metron, 10)
    session.commit()
    series = session.get(Series, result["series_id"])
    assert series.publisher.slug == "marvel" and series.publisher.metron_id == 1
    assert [i.number for i in series.issues] == ["1", "2", "300"]
    assert series.first_cover_date.year == 1963 and series.last_cover_date.year == 1988
    assert result["universes"] == ["earth-616"]   # rule-based default before issue detail exists
    assert series.image_url.endswith("1001.jpg")


def test_sync_issue_detail_links_everything(session, metron):
    metron_sync.sync_series(session, metron, 10)
    metron_sync.sync_issue(session, metron, 1002)
    session.commit()
    issue = session.scalar(select(Issue).where(Issue.metron_id == 1002))
    assert issue.title == "Story 2" and issue.deep_synced_at
    names = {i.name for i in session.scalars(select(Identity).join(Appearance).where(Appearance.issue_id == issue.id))}
    assert names == {"Spider-Man", "Mary Jane Watson"}
    spidey_app = session.scalar(select(Appearance).join(Identity).where(Identity.name == "Spider-Man"))
    assert spidey_app.role == AppearanceRole.MAIN          # series is named after him
    mj_app = session.scalar(select(Appearance).join(Identity).where(Identity.name == "Mary Jane Watson"))
    assert mj_app.role == AppearanceRole.SUPPORTING
    assert session.scalar(select(func.count()).select_from(Credit).where(Credit.issue_id == issue.id)) == 1
    uni = session.scalar(select(Universe).where(Universe.metron_id == 1))
    assert uni.slug == "earth-616"                          # Metron's "Earth 616" mapped onto the seeded universe
    su = session.scalar(select(SeriesUniverse).where(SeriesUniverse.series_id == issue.series_id))
    assert su.source.value == "metron"


def test_mantles_group_identities(session, metron):
    metron_sync.sync_character(session, metron, 100)
    metron_sync.sync_character(session, metron, 101)
    session.commit()
    spider = session.scalar(select(Character).where(Character.name == "Spider-Man"))
    assert sorted(i.display_name for i in spider.identities) == ["Miles Morales", "Spider-Man"]
    assert session.scalar(select(func.count()).select_from(TeamAffiliation)) == 2


def test_collected_edition_reprints_and_stub_relocation(session, metron):
    metron_sync.sync_issue(session, metron, 3001)        # TPB reprinting HoX #1-2 and PoX #1
    session.commit()
    tpb = session.scalar(select(Issue).where(Issue.metron_id == 3001))
    reprinted = session.scalars(select(CollectedIssue.issue_id).where(CollectedIssue.collection_issue_id == tpb.id)).all()
    assert len(reprinted) == 3
    stub = session.scalar(select(Issue).where(Issue.metron_id == 2001))
    assert stub.series.metron_id is None and stub.series.name == "House of X"
    metron_sync.sync_series(session, metron, 20)           # real series arrives: stub moves into it
    session.commit()
    session.refresh(stub)
    assert stub.series.metron_id == 20


def test_sync_arc_and_reading_list(session, metron):
    metron_sync.sync_series(session, metron, 20)
    metron_sync.sync_arc(session, metron, 300)
    out = metron_sync.sync_reading_list(session, metron, 500)
    session.commit()
    arc = session.scalar(select(Arc).where(Arc.metron_id == 300))
    assert arc.description == "The dawn of Krakoa." and arc.publisher_id is not None
    assert [ai.position for ai in session.scalars(select(ArcIssue).where(ArcIssue.arc_id == arc.id).order_by(ArcIssue.position))] == [0, 1]
    order = session.get(ReadingOrder, out["order_id"])
    assert [(e.issue_id is not None, e.tier) for e in order.entries] == [(True, Tier.ESSENTIAL), (True, Tier.TIE_IN)]
    assert "Community" in order.description


def test_comicvine_enrichment(session, metron, comicvine):
    metron_sync.sync_series(session, metron, 10)
    metron_sync.sync_issue(session, metron, 1003)           # cv_id 7000, where Peter "dies" in the fake
    metron_sync.sync_character(session, metron, 100)
    metron_sync.sync_character(session, metron, 101)
    metron_sync.sync_team(session, metron, 200)
    peter = session.scalar(select(Identity).where(Identity.metron_id == 100))
    result = comicvine_sync.enrich_identity(session, comicvine, peter.id)
    assert peter.real_name == "Peter Parker" and peter.display_name == "Peter Parker"
    assert "Web-Slinger" in peter.aliases
    assert result["first_appearance"] == "Amazing Fantasy #15 (1962)"
    death = session.scalar(select(CharacterEvent).where(CharacterEvent.kind == CharacterEventKind.DEATH))
    assert death.issue_id == session.scalar(select(Issue.id).where(Issue.cv_id == 7000))

    team = session.scalar(select(Team).where(Team.metron_id == 200))
    assert comicvine_sync.enrich_team(session, comicvine, team.id)["members_matched"] == 2

    issue_out = comicvine_sync.enrich_issue(session, comicvine, session.scalar(select(Issue.id).where(Issue.cv_id == 7000)))
    assert issue_out["first_appearances"] == 1   # Miles (fake data)


def test_memberships_derived_from_co_appearances(session, metron):
    for mid in (2001, 2002, 2201):
        metron_sync.sync_issue(session, metron, mid)
    metron_sync.sync_character(session, metron, 110, with_issues=False)
    metron_sync.sync_character(session, metron, 111, with_issues=False)
    team = session.scalar(select(Team).where(Team.metron_id == 201))
    out = derive_memberships(session, team.id)
    session.commit()
    assert out["derived"] == 2
    rows = {r["display_name"]: r for r in roster_timeline(session, team.id)}
    assert str(rows["Cyclops"]["from_date"]) == "2019-09-01" and str(rows["Cyclops"]["to_date"]) == "2021-11-01"
    assert rows["Jean Grey"]["from_label"] == "House of X #1"

    # A curated stint survives re-derivation
    session.add(Membership(team_id=team.id, identity_id=rows["Cyclops"]["identity_id"], source="curated", note="leader"))
    session.flush()
    assert derive_memberships(session, team.id)["curated_kept"] == 1
    cyclops_char = session.scalar(select(Identity).where(Identity.metron_id == 110)).character_id
    assert shared_team_history(session, cyclops_char)["links"][0]["name"] == "Jean Grey"


def test_linked_teams_by_shared_members(session, metron):
    metron_sync.sync_character(session, metron, 100, with_issues=False)
    s = session
    other = Team(name="New Avengers")
    s.add(other); s.flush()
    peter = s.scalar(select(Identity).where(Identity.metron_id == 100))
    s.add(TeamAffiliation(identity_id=peter.id, team_id=other.id)); s.flush()
    avengers = s.scalar(select(Team).where(Team.metron_id == 200))
    links = linked_teams(s, avengers.id)
    assert links[0]["name"] == "New Avengers" and links[0]["shared_members"] == 1


def test_job_queue_end_to_end(database, metron, comicvine):
    with db.session_scope() as s:
        job = jobs.enqueue(s, "metron.series", {"metron_id": 20})
        again = jobs.enqueue(s, "metron.series", {"metron_id": 20})
        assert again.id == job.id                          # deduplicated
    ran = jobs.run_pending()
    assert ran > 3
    with db.session_scope() as s:
        statuses = dict(s.execute(select(Job.kind, Job.status).where(Job.kind.in_(["metron.series", "metron.issue"]))).all())
        assert statuses["metron.series"] == JobStatus.DONE and statuses["metron.issue"] == JobStatus.DONE
        failed = s.scalars(select(Job).where(Job.status == JobStatus.FAILED)).all()
        assert not failed, [(j.kind, j.error) for j in failed]
        assert s.scalar(select(func.count()).select_from(Issue).where(Issue.deep_synced_at.is_not(None))) == 2
        # New characters got their own Metron + Comic Vine jobs, and the team was derived
        assert s.scalar(select(Identity.real_name).where(Identity.metron_id == 110)) == "Scott Summers"
        assert s.scalar(select(func.count()).select_from(Membership)) == 2


def test_rate_limited_job_is_deferred_not_failed(database, monkeypatch):
    class RateLimitError(Exception):
        retry_after = 120

    def boom(ctx, payload):
        raise RateLimitError("daily limit")
    monkeypatch.setitem(jobs.HANDLERS, "metron.publishers", boom)
    with db.session_scope() as s:
        jobs.enqueue(s, "metron.publishers")
    assert jobs.run_pending() == 1
    assert jobs.run_pending() == 0                          # not runnable again until run_after
    with db.session_scope() as s:
        job = s.scalar(select(Job))
        assert job.status == JobStatus.QUEUED and job.run_after is not None and "Rate limited" in job.error


def test_failed_job_rolls_back_partial_writes(database, monkeypatch):
    def half_then_fail(ctx, payload):
        ctx.session.add(Series(name="Half-written"))
        ctx.session.flush()
        raise RuntimeError("network died")
    monkeypatch.setitem(jobs.HANDLERS, "metron.publishers", half_then_fail)
    with db.session_scope() as s:
        jobs.enqueue(s, "metron.publishers")
    jobs.run_pending()
    with db.session_scope() as s:
        assert s.scalar(select(func.count()).select_from(Series).where(Series.name == "Half-written")) == 0
        assert s.scalar(select(Job.status)) == JobStatus.FAILED


def test_missing_credentials_fail_clearly(database, monkeypatch):
    monkeypatch.delenv("METRON_API_TOKEN", raising=False)
    monkeypatch.delenv("METRON_USERNAME", raising=False)
    from comix.ingest import clients
    clients.reset_clients()
    with db.session_scope() as s:
        jobs.enqueue(s, "metron.publishers")
    jobs.run_pending()
    with db.session_scope() as s:
        assert "credentials are not set" in s.scalar(select(Job.error))
