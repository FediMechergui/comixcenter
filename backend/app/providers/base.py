from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
import httpx

class MirrorLink(BaseModel):
    name: str  # e.g. "Datanodes", "Pixeldrain", "Terabox", "Direct", "VikingFile"
    url: str
    is_direct: bool = False

class ComicRelease(BaseModel):
    id: str  # Provider unique ID or composite key
    title: str
    clean_title: str
    series_name: Optional[str] = None
    issue_number: Optional[str] = None
    volume: Optional[str] = None
    year: Optional[int] = None
    publisher: Optional[str] = None  # "Marvel", "DC", "Image", "Independent", etc.
    universe_hint: Optional[str] = None  # e.g. "Earth-616", "New 52", "Absolute"
    format: str = "Issue"  # "Issue", "TPB", "Omnibus", "Weekly Pack", "Annual"
    cover_image_url: Optional[str] = None
    synopsis: Optional[str] = None
    published_at: Optional[datetime] = None
    source_provider: str
    source_url: str
    reader_url: Optional[str] = None  # Direct in-app / online reader URL
    download_mirrors: List[MirrorLink] = Field(default_factory=list)
    raw_metadata: Dict[str, Any] = Field(default_factory=dict)

class ComicPage(BaseModel):
    page_number: int
    image_url: str
    headers: Dict[str, str] = Field(default_factory=dict)

class ProviderUnavailableError(RuntimeError):
    """Raised when a provider can't serve requests, so health tracking records a failure instead of an empty success."""

class BaseComicProvider(ABC):
    """Abstract base provider for comic content sources."""
    name: str
    base_url: str
    # Set by the traffic middleware; any object with `async acquire(domain)`.
    rate_limiter: Optional[Any] = None

    def _client(self, headers: Dict[str, str], timeout: float) -> httpx.AsyncClient:
        """HTTP client that passes every outgoing request through the shared rate limiter."""
        async def throttle(request: httpx.Request):
            if self.rate_limiter is not None:
                await self.rate_limiter.acquire(request.url.host)

        return httpx.AsyncClient(headers=headers, timeout=timeout, event_hooks={"request": [throttle]})

    @abstractmethod
    async def fetch_latest_updates(self, page: int = 1, limit: int = 20) -> List[ComicRelease]:
        """Fetch latest comic releases chronologically."""
        pass

    @abstractmethod
    async def search(self, query: str, limit: int = 20) -> List[ComicRelease]:
        """Search comics by keyword or title."""
        pass

    @abstractmethod
    async def get_issue_pages(self, release: ComicRelease) -> List[ComicPage]:
        """Fetch or generate page image URLs for in-app reading."""
        pass
