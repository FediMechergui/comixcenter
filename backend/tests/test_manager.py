from datetime import datetime, timezone
from app.providers.base import ComicRelease, MirrorLink
from app.providers.manager import ComicSyncManager, sort_releases
from app.parser.title_cleaner import parse_comic_title


def make(title, provider="GetComics", **extra):
    p = parse_comic_title(title)
    fields = dict(
        id=f"{provider}-{title}", title=title, clean_title=p["clean_title"], series_name=p["series_name"],
        issue_number=p["issue_number"], volume=p["volume"], year=p["year"], format=p["format"],
        publisher=p["publisher"], source_provider=provider, source_url=f"https://example/{title}",
    )
    fields.update(extra)
    return ComicRelease(**fields)


def dedupe(*releases):
    return ComicSyncManager()._merge_and_deduplicate(list(releases))


def test_different_volumes_do_not_merge():
    assert len(dedupe(make("Batman Vol. 1 (2016)"), make("Batman Vol. 2 (2017)"))) == 2


def test_relaunches_years_apart_do_not_merge():
    assert len(dedupe(make("X-Men (2024) #1"), make("X-Men (1991) #1", "ReadComicsOnline"))) == 2


def test_tpb_does_not_merge_with_issue_one():
    assert len(dedupe(make("Batman TPB (2016)"), make("Batman #1 (2016)"))) == 2


def test_zero_padded_issue_numbers_merge():
    assert len(dedupe(make("Saga #001 (2024)"), make("Saga #1 (2024)", "ReadComicsOnline"))) == 1


def test_cover_year_vs_series_year_still_merge():
    out = dedupe(make("X-Men #20 (2025)"), make("X-Men (2024-) #20", "ReadComicsOnline"))
    assert len(out) == 1


def test_merge_combines_capabilities_without_overwriting():
    gc = make("Saga #70 (2024)", download_mirrors=[
        MirrorLink(name="Direct Download", url="https://a/1"),
        MirrorLink(name="Direct Download", url="https://a/2"),
    ], raw_metadata={"post_id": "9"})
    rco = make("Saga #70 (2024)", "ReadComicsOnline", reader_url="https://rco/saga/70",
               cover_image_url="https://rco/cover.jpg", raw_metadata={"post_id": "x", "slug": "saga"})
    [merged] = dedupe(gc, rco)
    assert merged.reader_url == "https://rco/saga/70"
    assert merged.cover_image_url == "https://rco/cover.jpg"
    assert len(merged.download_mirrors) == 2
    assert merged.raw_metadata["post_id"] == "9"
    assert merged.raw_metadata["slug"] == "saga"
    assert merged.raw_metadata["merged_from"] == ["GetComics", "ReadComicsOnline"]


def test_sort_puts_recent_dated_release_above_year_only_release():
    dated = make("A #1", published_at=datetime(2026, 10, 3, tzinfo=timezone.utc))
    naive = make("B #1", published_at=datetime(2026, 10, 2))
    year_only = make("C #1 (2020)")
    nothing = make("D #1")
    assert [r.title for r in sort_releases([nothing, year_only, naive, dated])] == ["A #1", "B #1", "C #1 (2020)", "D #1"]
