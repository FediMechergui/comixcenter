import asyncio
from datetime import datetime, timezone
from typing import List
from app.providers.base import ComicRelease
from app.providers.getcomics import GetComicsProvider
from app.providers.readcomicsonline import ReadComicsOnlineProvider
from app.providers.batcave import BatcaveProvider
from app.parser.title_cleaner import normalize_issue_number
from rapidfuzz import fuzz

# GetComics titles carry the cover year, RCO titles the series start year, so the
# same issue can differ by a year or two; relaunches years apart must not merge.
YEAR_TOLERANCE = 2
SERIES_MATCH_THRESHOLD = 80


def release_sort_key(rel: ComicRelease) -> float:
    """Newest first: exact publish time when known, else 1 Jan of the year, else oldest."""
    if rel.published_at:
        dt = rel.published_at
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    if rel.year:
        return datetime(rel.year, 1, 1, tzinfo=timezone.utc).timestamp()
    return float("-inf")


def sort_releases(releases: List[ComicRelease]) -> List[ComicRelease]:
    return sorted(releases, key=release_sort_key, reverse=True)


def is_same_release(a: ComicRelease, b: ComicRelease) -> bool:
    """True when two listings describe the same book (series, issue, volume, format and era agree)."""
    issue_a, issue_b = normalize_issue_number(a.issue_number), normalize_issue_number(b.issue_number)
    if issue_a != issue_b:
        return False
    if a.format != b.format:
        return False
    if a.volume and b.volume and a.volume != b.volume:
        return False
    # Collections without issue or volume numbers are too ambiguous to merge on name alone
    if issue_a is None and not (a.volume and b.volume):
        return False
    if a.year and b.year and abs(a.year - b.year) > YEAR_TOLERANCE:
        return False
    ratio = fuzz.token_sort_ratio(a.series_name or a.clean_title, b.series_name or b.clean_title)
    return ratio >= SERIES_MATCH_THRESHOLD


class ComicSyncManager:
    """
    Unified manager that polls, deduplicates, and enriches comic releases across all sources.
    """
    def __init__(self):
        self.getcomics = GetComicsProvider()
        self.rco = ReadComicsOnlineProvider()
        self.batcave = BatcaveProvider()

    async def fetch_all_latest(self, limit: int = 30) -> List[ComicRelease]:
        """
        Fetches latest releases concurrently from GetComics and ReadComicsOnline,
        then merges and deduplicates them.
        """
        results = await asyncio.gather(
            self.getcomics.fetch_latest_updates(limit=limit),
            self.rco.fetch_latest_updates(limit=limit),
            return_exceptions=True
        )

        all_releases: List[ComicRelease] = []
        for r in results:
            if isinstance(r, list):
                all_releases.extend(r)

        return sort_releases(self._merge_and_deduplicate(all_releases))

    async def fetch_by_publisher(self, publisher: str, limit: int = 20) -> List[ComicRelease]:
        """
        Fetches latest comics specifically for Marvel, DC, or Independents.
        """
        pub_lower = publisher.lower()
        gc_pub = "marvel" if "marvel" in pub_lower else ("dc" if pub_lower.split()[:1] == ["dc"] else "other")

        # GetComics has dedicated publisher category feeds
        gc_releases = await self.getcomics.fetch_latest_updates(limit=limit * 2, publisher=gc_pub)

        # Marvel/DC come straight from their category feed; other publishers are
        # narrowed down from the "other" feed by the detected publisher name.
        if gc_pub != "other":
            return gc_releases[:limit]
        filtered = [r for r in gc_releases if r.publisher and r.publisher.lower().rstrip("!") == pub_lower.rstrip("!")]
        return filtered[:limit]

    async def search_across_all(self, query: str) -> List[ComicRelease]:
        """
        Search both catalogs concurrently and combine results.
        """
        results = await asyncio.gather(
            self.getcomics.search(query),
            self.rco.search(query),
            return_exceptions=True
        )
        all_releases: List[ComicRelease] = []
        for r in results:
            if isinstance(r, list):
                all_releases.extend(r)
        return self._merge_and_deduplicate(all_releases)

    def _merge_and_deduplicate(self, releases: List[ComicRelease]) -> List[ComicRelease]:
        """
        If an issue is found on both GetComics (downloads) and RCO (stream),
        merge them into a single record with both capabilities.
        """
        unique_releases: List[ComicRelease] = []

        for rel in releases:
            for existing in unique_releases:
                if is_same_release(rel, existing):
                    self._merge_into(existing, rel)
                    break
            else:
                unique_releases.append(rel)

        return unique_releases

    def _merge_into(self, target: ComicRelease, source: ComicRelease):
        """Enriches target release with any additional data from source, never overwriting what it has."""
        existing_urls = {m.url for m in target.download_mirrors}
        for m in source.download_mirrors:
            if m.url not in existing_urls:
                target.download_mirrors.append(m)
                existing_urls.add(m.url)

        for field in ("reader_url", "cover_image_url", "synopsis", "volume", "year", "published_at"):
            if getattr(target, field) is None and getattr(source, field) is not None:
                setattr(target, field, getattr(source, field))
        if target.publisher in (None, "Independent") and source.publisher not in (None, "Independent"):
            target.publisher = source.publisher

        for key, value in source.raw_metadata.items():
            target.raw_metadata.setdefault(key, value)
        sources = target.raw_metadata.setdefault("merged_from", [target.source_provider])
        if source.source_provider not in sources:
            sources.append(source.source_provider)
