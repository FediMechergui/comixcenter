import asyncio
import time
from typing import List, Dict, Optional, Any
from pydantic import BaseModel
from datetime import datetime, timezone

from app.providers.base import ComicRelease, ComicPage
from app.providers.manager import ComicSyncManager, sort_releases

class ProviderHealth(BaseModel):
    name: str
    is_available: bool = True
    # Paused until a session is supplied; cooldown expiry alone doesn't re-enable it
    awaiting_session: bool = False
    consecutive_failures: int = 0
    last_failure_reason: Optional[str] = None
    last_success_at: Optional[datetime] = None
    cooldown_until: float = 0.0

class DomainRateLimiter:
    """
    Per-host request spacing: each domain gets at most `requests_per_second`,
    with bursts queued and released evenly. Waiting on one domain never delays another.
    """
    def __init__(self, requests_per_second: float = 2.0):
        self.interval = 1.0 / requests_per_second
        self._next_slot: Dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, domain: str):
        # Reserve the next free slot under the lock, then sleep outside it
        async with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_slot.get(domain, 0.0))
            self._next_slot[domain] = slot + self.interval
        wait = slot - now
        if wait > 0:
            await asyncio.sleep(wait)

class ScraperTrafficMiddleware:
    """
    Orchestrates traffic across GetComics, ReadComicsOnline, and Batcave with:
    - Circuit Breakers (a provider pauses after repeated failures, then gets a trial call after cooldown)
    - Domain Rate Limiting (applied to every outgoing provider request)
    - Session & Cookie Injection for protected providers (Batcave cf_clearance)
    - Unified Query Routing
    """

    def __init__(self, failure_threshold: int = 3, cooldown_seconds: float = 120.0, provider_timeout: float = 30.0):
        self.rate_limiter = DomainRateLimiter(requests_per_second=2.5)
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        # Upper bound per provider call, so one slow source can't hold up the merged feed
        self.provider_timeout = provider_timeout

        # One set of providers, shared with the sync manager
        self.sync_manager = ComicSyncManager()
        self.getcomics = self.sync_manager.getcomics
        self.rco = self.sync_manager.rco
        self.batcave = self.sync_manager.batcave
        for provider in (self.getcomics, self.rco, self.batcave):
            provider.rate_limiter = self.rate_limiter

        # Health tracking for Circuit Breakers
        self.health: Dict[str, ProviderHealth] = {
            "GetComics": ProviderHealth(name="GetComics", is_available=True),
            "ReadComicsOnline": ProviderHealth(name="ReadComicsOnline", is_available=True),
            "Batcave": ProviderHealth(
                name="Batcave",
                is_available=True,
                awaiting_session=False,
            ),
        }

        # Cached session credentials (e.g. for Batcave)
        self.session_credentials: Dict[str, Dict[str, str]] = {}

    def configure_batcave_session(self, cf_clearance: str, user_agent: Optional[str] = None):
        """
        Stores a Cloudflare clearance cookie for the Batcave adapter and re-enables it.
        (Now largely obsolete as Batcave uses a local CDP browser to solve CF natively)
        """
        if hasattr(self.batcave, "headers"):
            self.session_credentials["batcave"] = {
                "cf_clearance": cf_clearance,
                "user_agent": user_agent or self.batcave.headers.get("User-Agent", "")
            }
            self.batcave.headers["Cookie"] = f"cf_clearance={cf_clearance}"
            if user_agent:
                self.batcave.headers["User-Agent"] = user_agent

        h = self.health["Batcave"]
        h.is_available = True
        h.awaiting_session = False
        h.consecutive_failures = 0
        h.last_failure_reason = None
        h.cooldown_until = 0.0

    async def get_latest_feed(self, limit: int = 30) -> List[ComicRelease]:
        """
        Fetches latest updates from all healthy providers, merged and newest first.
        """
        providers = [
            ("GetComics", self.getcomics),
            ("ReadComicsOnline", self.rco),
            ("Batcave", self.batcave),
        ]
        tasks = [
            self._safe_execute(name, provider.fetch_latest_updates(limit=limit))
            for name, provider in providers
            if self._is_provider_healthy(name)
        ]

        results = await asyncio.gather(*tasks)
        all_releases: List[ComicRelease] = [rel for r in results for rel in r]
        return sort_releases(self.sync_manager._merge_and_deduplicate(all_releases))[:limit]

    async def get_publisher_feed(self, publisher: str, limit: int = 20) -> List[ComicRelease]:
        """
        Dedicated publisher-specific routing (Marvel vs DC vs Indies), served from GetComics.
        """
        if not self._is_provider_healthy("GetComics"):
            return []
        return await self._safe_execute("GetComics", self.sync_manager.fetch_by_publisher(publisher, limit=limit))

    async def resolve_comic_stream(self, release: ComicRelease) -> List[ComicPage]:
        """
        Resolves streamable pages from RCO. A chapter with no pages is a content miss,
        not a provider failure, so only exceptions count against the circuit breaker.
        """
        if not self._is_provider_healthy("ReadComicsOnline"):
            return []
        return await self._safe_execute("ReadComicsOnline", self.rco.get_issue_pages(release))

    def get_status_report(self) -> Dict[str, Any]:
        """Provides real-time health and traffic stats for monitoring."""
        now = time.time()
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "providers": {
                name: {
                    "available": self._is_provider_healthy(name),
                    "needs_session": h.awaiting_session,
                    "consecutive_failures": h.consecutive_failures,
                    "last_failure_reason": h.last_failure_reason,
                    "last_success_at": h.last_success_at.isoformat() if h.last_success_at else None,
                    "is_in_cooldown": now < h.cooldown_until
                }
                for name, h in self.health.items()
            }
        }

    # Internal Circuit Breaker Helpers

    def _is_provider_healthy(self, name: str) -> bool:
        h = self.health.get(name)
        if not h or h.awaiting_session:
            return False
        # A tripped breaker whose cooldown has expired is half-open: allow a trial
        # call. Success closes it; another failure re-trips it immediately.
        return time.time() >= h.cooldown_until

    async def _safe_execute(self, name: str, coro):
        try:
            res = await asyncio.wait_for(coro, self.provider_timeout)
        except TimeoutError:
            self._record_failure(name, f"Timed out after {self.provider_timeout:g}s")
            return []
        except Exception as e:
            self._record_failure(name, f"{type(e).__name__}: {e}")
            return []
        self._record_success(name)
        return res

    def _record_success(self, name: str):
        h = self.health.get(name)
        if h:
            h.is_available = True
            h.consecutive_failures = 0
            h.last_success_at = datetime.now(timezone.utc)
            h.cooldown_until = 0.0

    def _record_failure(self, name: str, reason: str):
        h = self.health.get(name)
        if h:
            h.consecutive_failures += 1
            h.last_failure_reason = reason
            if h.consecutive_failures >= self.failure_threshold:
                h.is_available = False
                h.cooldown_until = time.time() + self.cooldown_seconds
