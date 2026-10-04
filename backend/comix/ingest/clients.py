"""Lazily created API clients for Metron (mokkari) and Comic Vine (simyan)."""
import threading
from typing import Any, Optional

from comix.config import get_settings


class NotConfiguredError(RuntimeError):
    """The API credentials for a source are missing from backend/.env."""


_lock = threading.Lock()
_metron: Optional[Any] = None
_comicvine: Optional[Any] = None


def get_metron() -> Any:
    global _metron
    with _lock:
        if _metron is None:
            settings = get_settings()
            if not settings.metron_configured:
                raise NotConfiguredError("Metron credentials are not set (METRON_API_TOKEN or METRON_USERNAME/PASSWORD)")
            import mokkari
            from mokkari.rate_limit import HeaderPacedRateLimiter
            from mokkari.sqlite_cache import SqliteCache
            cache = SqliteCache(str(settings.cache_dir / "metron_cache.db"), expire=7)
            _metron = mokkari.api(
                username=settings.metron_username, passwd=settings.metron_password,
                api_token=settings.metron_api_token, cache=cache, user_agent=settings.user_agent,
                # Waits for the per-minute window instead of failing; the daily limit still raises
                rate_limiter=HeaderPacedRateLimiter(),
            )
        return _metron


def get_comicvine() -> Any:
    global _comicvine
    with _lock:
        if _comicvine is None:
            settings = get_settings()
            if not settings.comicvine_configured:
                raise NotConfiguredError("Comic Vine API key is not set (COMICVINE_API_KEY)")
            from simyan.comicvine import Comicvine
            _comicvine = Comicvine(
                api_key=settings.comicvine_api_key, user_agent=settings.user_agent,
                cache_path=settings.cache_dir / "comicvine_cache.sqlite",
                ratelimit_path=settings.cache_dir / "comicvine_ratelimit.sqlite",
            )
        return _comicvine


def reset_clients() -> None:
    global _metron, _comicvine
    with _lock:
        _metron = _comicvine = None
