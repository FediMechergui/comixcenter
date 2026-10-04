import asyncio
import time
from app.middleware.traffic_orchestrator import ScraperTrafficMiddleware, DomainRateLimiter
from app.providers.base import ComicRelease


async def failing():
    raise RuntimeError("403 Forbidden")


async def succeeding():
    return ["ok"]


def test_breaker_trips_then_recovers_after_cooldown():
    mw = ScraperTrafficMiddleware(failure_threshold=2, cooldown_seconds=0.05)
    for _ in range(2):
        asyncio.run(mw._safe_execute("GetComics", failing()))
    assert not mw._is_provider_healthy("GetComics")

    time.sleep(0.1)
    assert mw._is_provider_healthy("GetComics")  # half-open: trial call allowed

    assert asyncio.run(mw._safe_execute("GetComics", succeeding())) == ["ok"]
    assert mw.health["GetComics"].consecutive_failures == 0


def test_half_open_failure_re_trips_immediately():
    mw = ScraperTrafficMiddleware(failure_threshold=2, cooldown_seconds=0.05)
    for _ in range(2):
        asyncio.run(mw._safe_execute("GetComics", failing()))
    time.sleep(0.1)
    asyncio.run(mw._safe_execute("GetComics", failing()))
    assert not mw._is_provider_healthy("GetComics")


def fake_feed(prefix, count, delay=0.0):
    async def fetch_latest_updates(limit=20, **kwargs):
        await asyncio.sleep(delay)
        # Distinct issue numbers so the merge step keeps every item separate
        return [ComicRelease(id=f"{prefix}{i}", title=f"{prefix} Series #{i}", clean_title=f"{prefix} Series",
                             series_name=f"{prefix} Series", issue_number=f"{len(prefix)}{i}", source_provider=prefix,
                             source_url=f"https://{prefix}/{i}") for i in range(count)]
    return fetch_latest_updates


def test_slow_provider_times_out_without_holding_up_the_feed(monkeypatch):
    mw = ScraperTrafficMiddleware(failure_threshold=1, provider_timeout=0.2)
    monkeypatch.setattr(mw.getcomics, "fetch_latest_updates", fake_feed("gc", 2))
    monkeypatch.setattr(mw.rco, "fetch_latest_updates", fake_feed("rco", 2))
    monkeypatch.setattr(mw.batcave, "fetch_latest_updates", fake_feed("bc", 2, delay=5))

    start = time.monotonic()
    feed = asyncio.run(mw.get_latest_feed(limit=10))
    assert time.monotonic() - start < 1
    assert {r.source_provider for r in feed} == {"gc", "rco"}
    assert mw.health["Batcave"].last_failure_reason == "Timed out after 0.2s"
    assert not mw._is_provider_healthy("Batcave")


def test_latest_feed_respects_limit(monkeypatch):
    mw = ScraperTrafficMiddleware()
    for provider, prefix in ((mw.getcomics, "gc"), (mw.rco, "rco"), (mw.batcave, "bc")):
        monkeypatch.setattr(provider, "fetch_latest_updates", fake_feed(prefix, 5))
    assert len(asyncio.run(mw.get_latest_feed(limit=5))) == 5


def test_providers_are_shared_and_rate_limited():
    mw = ScraperTrafficMiddleware()
    assert mw.getcomics is mw.sync_manager.getcomics
    assert mw.getcomics.rate_limiter is mw.rate_limiter


def test_rate_limiter_spaces_one_domain_without_blocking_others():
    async def scenario():
        limiter = DomainRateLimiter(requests_per_second=10)  # 0.1s spacing
        start = time.monotonic()
        stamps = {}

        async def hit(domain, key):
            await limiter.acquire(domain)
            stamps[key] = time.monotonic() - start

        await asyncio.gather(hit("a.com", "a1"), hit("a.com", "a2"), hit("a.com", "a3"), hit("b.com", "b1"))
        return stamps

    stamps = asyncio.run(scenario())
    assert stamps["b1"] < 0.05           # other domain not held up by a.com's queue
    assert stamps["a3"] >= 0.19          # three a.com calls spaced ~0.1s apart
