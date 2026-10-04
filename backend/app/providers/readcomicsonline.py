import re
import html
from typing import List, Optional, Dict, Any
from email.utils import parsedate_to_datetime

from app.providers.base import BaseComicProvider, ComicRelease, ComicPage
from app.parser.title_cleaner import parse_comic_title

class ReadComicsOnlineProvider(BaseComicProvider):
    name = "ReadComicsOnline"
    base_url = "https://readcomicsonline.ru"
    feed_url = "https://readcomicsonline.ru/feed"
    cdn_base_url = "https://cdn.readcomicsonline.ru/uploads/manga"

    def __init__(self, timeout: float = 15.0):
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "application/rss+xml, application/xml, text/xml, */*",
        }
        self.cdn_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        }
        self.timeout = timeout

    async def fetch_latest_updates(self, page: int = 1, limit: int = 20) -> List[ComicRelease]:
        """
        Fetch the latest 50 live comic updates directly from RCO's real-time RSS feed.
        """
        async with self._client(self.headers, self.timeout) as client:
            resp = await client.get(self.feed_url)
            resp.raise_for_status()
            xml_text = resp.text

        items = re.findall(r'<item>(.*?)</item>', xml_text, re.DOTALL)
        releases: List[ComicRelease] = []

        for item in items[:limit]:
            release = self._parse_feed_item(item)
            if release:
                releases.append(release)

        return releases

    async def search(self, query: str, limit: int = 20) -> List[ComicRelease]:
        """
        Filter current feed items or query for comic titles.
        """
        all_items = await self.fetch_latest_updates(limit=50)
        q_lower = query.lower()
        matched = [r for r in all_items if q_lower in r.title.lower() or q_lower in (r.series_name or "").lower()]
        return matched[:limit]

    async def get_issue_pages(self, release: ComicRelease, max_pages: int = 120) -> List[ComicPage]:
        """
        Generates and verifies the page stream for an issue.
        RCO CDN stores images deterministically:
        https://cdn.readcomicsonline.ru/uploads/manga/{slug}/chapters/{chapter}/{page:02d}.jpg
        """
        slug = release.raw_metadata.get("slug")
        chapter = release.raw_metadata.get("chapter")

        if not slug or not chapter:
            # Extract from reader_url
            url_match = re.search(r'/comic/([^/]+)/([^/]+)', release.reader_url or release.source_url)
            if url_match:
                slug, chapter = url_match.group(1), url_match.group(2)
            else:
                return []

        # Fast prioritized probe list: standard 2-digit zero pad is the vast majority
        ch_str = str(chapter)
        candidates = [
            f"{self.cdn_base_url}/{slug}/chapters/{ch_str}/01.jpg",
            f"{self.cdn_base_url}/{slug}/chapters/{ch_str}/01.webp",
            f"{self.cdn_base_url}/{slug}/chapters/{ch_str}/001.jpg",
            f"{self.cdn_base_url}/{slug}/chapters/{ch_str}/1.jpg",
        ]
        try:
            ch_int = int(ch_str)
            candidates.append(f"{self.cdn_base_url}/{slug}/chapters/{ch_int:02d}/01.jpg")
        except ValueError:
            pass

        matched_pattern = None
        async with self._client(self.cdn_headers, 3.0) as client:
            for url in candidates:
                try:
                    resp = await client.head(url)
                    if resp.status_code == 200:
                        # Extract the matching chapter, pad, and extension
                        m = re.search(r'/chapters/([^/]+)/(\d+)\.([a-z0-9]+)', url)
                        if m:
                            matched_ch, num_str, ext = m.group(1), m.group(2), m.group(3)
                            matched_pad = len(num_str)
                            matched_pattern = (matched_ch, matched_pad, ext)
                            break
                except Exception:
                    continue

        if not matched_pattern:
            return []

        matched_ch, matched_pad, matched_ext = matched_pattern
        pages: List[ComicPage] = []
        for p in range(1, max_pages + 1):
            p_str = f"{p:0{matched_pad}d}" if matched_pad > 1 else str(p)
            page_url = f"{self.cdn_base_url}/{slug}/chapters/{matched_ch}/{p_str}.{matched_ext}"
            pages.append(ComicPage(
                page_number=p,
                image_url=page_url,
                headers=self.cdn_headers
            ))

        return pages

    def _parse_feed_item(self, item_xml: str) -> Optional[ComicRelease]:
        title_m = re.search(r'<title>(.*?)</title>', item_xml, re.DOTALL)
        link_m = re.search(r'<link>(.*?)</link>', item_xml, re.DOTALL)
        date_m = re.search(r'<pubDate>(.*?)</pubDate>', item_xml, re.DOTALL)

        if not title_m or not link_m:
            return None

        raw_title = title_m.group(1).replace("<![CDATA[", "").replace("]]>", "").strip()
        link = link_m.group(1).replace("<![CDATA[", "").replace("]]>", "").strip()

        published_at = None
        if date_m:
            try:
                date_str = date_m.group(1).strip()
                published_at = parsedate_to_datetime(date_str)
            except (TypeError, ValueError):
                pass

        # Extract slug and chapter from link: e.g. https://readcomicsonline.ru/comic/super-mondo-mega-mutts/3
        slug, chapter = None, None
        path_match = re.search(r'/comic/([^/]+)/([^/]+)', link)
        if path_match:
            slug = path_match.group(1)
            chapter = path_match.group(2)

        parsed = parse_comic_title(raw_title)

        # Build cover preview URL if possible
        cover_url = f"{self.cdn_base_url}/{slug}/cover/cover_250x350.jpg" if slug else None

        return ComicRelease(
            id=f"rco-{slug}-{chapter}" if slug and chapter else f"rco-{link}",
            title=html.unescape(raw_title),
            clean_title=parsed["clean_title"],
            series_name=parsed["series_name"],
            issue_number=parsed["issue_number"] or chapter,
            volume=parsed["volume"],
            year=parsed["year"],
            publisher=parsed["publisher"],
            format=parsed["format"],
            cover_image_url=cover_url,
            synopsis=None,
            published_at=published_at,
            source_provider=self.name,
            source_url=link,
            reader_url=link,
            download_mirrors=[],
            raw_metadata={"slug": slug, "chapter": chapter}
        )
