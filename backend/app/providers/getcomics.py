import re
import html
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

from app.providers.base import BaseComicProvider, ComicRelease, MirrorLink, ComicPage
from app.parser.title_cleaner import parse_comic_title

class GetComicsProvider(BaseComicProvider):
    name = "GetComics"
    base_url = "https://getcomics.org"
    api_url = "https://getcomics.org/wp-json/wp/v2"

    CATEGORY_MAP = {
        "dc": 2,
        "marvel": 3,
        "other": 212,
        "all": None
    }

    def __init__(self, timeout: float = 15.0):
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "application/json, text/html, */*",
        }
        self.timeout = timeout

    async def fetch_latest_updates(
        self,
        page: int = 1,
        limit: int = 20,
        publisher: Optional[str] = None
    ) -> List[ComicRelease]:
        """
        Fetch latest comic releases chronologically from GetComics.
        publisher can be 'marvel', 'dc', 'other', or None for all.
        """
        params: Dict[str, Any] = {
            "page": page,
            "per_page": min(limit, 50),
            "_embed": 1
        }
        if publisher and publisher.lower() in self.CATEGORY_MAP and self.CATEGORY_MAP[publisher.lower()]:
            params["categories"] = self.CATEGORY_MAP[publisher.lower()]

        url = f"{self.api_url}/posts"
        async with self._client(self.headers, self.timeout) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            posts = resp.json()

        releases = []
        for post in posts:
            release = self._parse_post(post, publisher_hint=publisher)
            if release:
                releases.append(release)
        return releases

    async def search(self, query: str, limit: int = 20) -> List[ComicRelease]:
        """Search GetComics posts by keyword/title."""
        params = {
            "search": query,
            "per_page": min(limit, 50),
            "_embed": 1
        }
        url = f"{self.api_url}/posts"
        async with self._client(self.headers, self.timeout) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            posts = resp.json()

        releases = []
        for post in posts:
            release = self._parse_post(post)
            if release:
                releases.append(release)
        return releases

    async def get_issue_pages(self, release: ComicRelease) -> List[ComicPage]:
        """
        GetComics provides downloadable archive files (CBZ/CBR).
        If an online reader link was attached to the post (e.g. ReadComicsOnline),
        we delegate or return it.
        """
        # For direct reading, we extract via reader_url if available
        return []

    def _parse_post(self, post: Dict[str, Any], publisher_hint: Optional[str] = None) -> Optional[ComicRelease]:
        post_id = str(post.get("id"))
        raw_title = post.get("title", {}).get("rendered", "")
        if not raw_title:
            return None

        content = post.get("content", {}).get("rendered", "")
        source_url = post.get("link", "")
        # "date_gmt" is UTC; "date" is in the site's local timezone
        pub_date_str = post.get("date_gmt") or post.get("date")
        published_at = None
        if pub_date_str:
            try:
                dt = datetime.fromisoformat(pub_date_str)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                published_at = dt
            except ValueError:
                pass

        # 1. Parse structured title
        parsed = parse_comic_title(raw_title, category_name=publisher_hint)
        
        # 2. Extract Cover Image
        cover_url = None
        # From embedded media or regex in content
        if "_embedded" in post and "wp:featuredmedia" in post["_embedded"]:
            media_list = post["_embedded"]["wp:featuredmedia"]
            if media_list and isinstance(media_list, list) and "source_url" in media_list[0]:
                cover_url = media_list[0]["source_url"]

        if not cover_url and content:
            img_match = re.search(r'<img[^>]+src="([^">]+)"', content)
            if img_match:
                cover_url = img_match.group(1)

        # 3. Extract Mirrors and Reader links
        mirrors: List[MirrorLink] = []
        reader_url: Optional[str] = None

        links = re.findall(r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>', content, re.IGNORECASE)
        for href, text in links:
            clean_btn = re.sub(r'<[^>]+>', '', text).strip().upper()
            if "READ ONLINE" in clean_btn or "READCOMICSONLINE" in href:
                reader_url = href
            elif "DATANODES" in clean_btn:
                mirrors.append(MirrorLink(name="Datanodes", url=href, is_direct=True))
            elif "PIXELDRAIN" in clean_btn:
                mirrors.append(MirrorLink(name="Pixeldrain", url=href))
            elif "VIKINGFILE" in clean_btn:
                mirrors.append(MirrorLink(name="VikingFile", url=href))
            elif "TERABOX" in clean_btn:
                mirrors.append(MirrorLink(name="TeraBox", url=href))
            elif "DOWNLOAD NOW" in clean_btn:
                mirrors.append(MirrorLink(name="Direct Download", url=href, is_direct=True))

        # 4. Extract synopsis
        synopsis = None
        story_match = re.search(r'The Story\s*–?[^<]*</h2>\s*<p>(.*?)</p>', content, re.DOTALL | re.IGNORECASE)
        if story_match:
            synopsis = re.sub(r'<[^>]+>', '', story_match.group(1)).strip()
        else:
            # Fallback to excerpt
            excerpt = post.get("excerpt", {}).get("rendered", "")
            if excerpt:
                synopsis = re.sub(r'<[^>]+>', '', excerpt).strip()

        return ComicRelease(
            id=f"getcomics-{post_id}",
            title=html.unescape(raw_title),
            clean_title=parsed["clean_title"],
            series_name=parsed["series_name"],
            issue_number=parsed["issue_number"],
            volume=parsed["volume"],
            year=parsed["year"],
            publisher=parsed["publisher"],
            format=parsed["format"],
            cover_image_url=cover_url,
            synopsis=synopsis,
            published_at=published_at,
            source_provider=self.name,
            source_url=source_url,
            reader_url=reader_url,
            download_mirrors=mirrors,
            raw_metadata={"post_id": post_id, "categories": post.get("categories", [])}
        )
