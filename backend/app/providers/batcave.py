import asyncio
from typing import List, Optional
import json
import re
from bs4 import BeautifulSoup
import hashlib

from app.providers.base import BaseComicProvider, ComicRelease, ComicPage, ProviderUnavailableError
from app.browser.cdp import ChromeBrowser
from app.parser.title_cleaner import parse_comic_title


class BatcaveProvider(BaseComicProvider):
    name = "Batcave"
    base_url = "https://batcave.biz"
    
    def __init__(self, proxy_or_solver_url: Optional[str] = None, timeout: float = 15.0):
        self.proxy_or_solver_url = proxy_or_solver_url
        self.timeout = timeout
        self._browser: Optional[ChromeBrowser] = None
        self._browser_lock = asyncio.Lock()
        # Keep an empty dict so older tests expecting `headers` don't completely fail
        self.headers = {}

    async def _get_browser(self) -> ChromeBrowser:
        if not self._browser:
            self._browser = ChromeBrowser(profile_dir="scratch/chrome_profile")
            await self._browser.start()
        return self._browser
        
    def _generate_id(self, url: str, issue_number: Optional[str]) -> str:
        """Deterministic ID based on the series URL and issue."""
        key = f"{url}#{issue_number}" if issue_number else url
        return hashlib.md5(key.encode()).hexdigest()

    async def fetch_latest_updates(self, page: int = 1, limit: int = 20) -> List[ComicRelease]:
        async with self._browser_lock:
            if self.rate_limiter:
                await self.rate_limiter.acquire("batcave.biz")
                
            browser = await self._get_browser()
            await browser.ensure_origin(self.base_url)
            
            url = f"{self.base_url}/page/{page}/" if page > 1 else f"{self.base_url}/"
            if self.rate_limiter:
                await self.rate_limiter.acquire("batcave.biz")
            await browser.navigate_and_wait(url)

            html = await browser.evaluate("document.documentElement.outerHTML")
            
        soup = BeautifulSoup(html, "html.parser")
        items = soup.find_all(class_="latest")
        
        releases = []
        for item in items:
            title_el = item.find(class_="latest__title")
            if not title_el:
                continue
            raw_series = title_el.text.strip()
            
            a_tag = item.find("a")
            reader_url = a_tag["href"] if a_tag else ""
            if reader_url.startswith("/"):
                reader_url = self.base_url + reader_url
                
            img_el = item.find("img")
            cover_url = img_el["src"] if img_el else None
            if cover_url and cover_url.startswith("/"):
                cover_url = self.base_url + cover_url
            
            chap_el = item.find(class_="latest__chapter")
            full_title = chap_el.text.strip() if chap_el else raw_series
            full_title = re.sub(r'^\d{2}\.\d{2}\.\d{4}\s*-\s*', '', full_title)
            
            parsed = parse_comic_title(full_title)
            release_id = self._generate_id(reader_url, parsed["issue_number"])
            
            releases.append(ComicRelease(
                id=release_id,
                title=full_title,
                clean_title=parsed["clean_title"],
                source_provider=self.name,
                source_url=reader_url,
                raw_metadata={"batcave_series_url": reader_url, "batcave_issue_title": full_title},
                series_name=parsed["series_name"],
                issue_number=parsed["issue_number"],
                year=parsed["year"],
                publisher=parsed["publisher"],
                format=parsed["format"],
                volume=parsed["volume"],
                reader_url=reader_url,
                cover_image_url=cover_url,
            ))
            
            if len(releases) >= limit:
                break
                
        return releases

    async def search(self, query: str, limit: int = 20) -> List[ComicRelease]:
        async with self._browser_lock:
            if self.rate_limiter:
                await self.rate_limiter.acquire("batcave.biz")
                
            browser = await self._get_browser()
            await browser.ensure_origin(self.base_url)
            
            url = f"{self.base_url}/index.php?do=search&subaction=search&story={query}"
            if self.rate_limiter:
                await self.rate_limiter.acquire("batcave.biz")
            await browser.navigate_and_wait(url)

            html = await browser.evaluate("document.documentElement.outerHTML")
            
        soup = BeautifulSoup(html, "html.parser")
        items = soup.find_all(class_="readed")
        
        releases = []
        for item in items:
            title_el = item.find(class_="readed__title")
            if not title_el:
                continue
            raw_series = title_el.text.strip()
            
            a_tag = item.find("a")
            reader_url = a_tag["href"] if a_tag else ""
            if reader_url.startswith("/"):
                reader_url = self.base_url + reader_url
                
            img_el = item.find("img")
            cover_url = img_el["src"] if img_el else None
            if cover_url and cover_url.startswith("/"):
                cover_url = self.base_url + cover_url
            
            parsed = parse_comic_title(raw_series)
            release_id = self._generate_id(reader_url, None)
            
            releases.append(ComicRelease(
                id=release_id,
                title=raw_series,
                clean_title=parsed["clean_title"],
                source_provider=self.name,
                source_url=reader_url,
                raw_metadata={"batcave_series_url": reader_url},
                series_name=parsed["series_name"],
                issue_number=None,
                year=parsed["year"],
                publisher=parsed["publisher"],
                format=parsed["format"],
                volume=parsed["volume"],
                reader_url=reader_url,
                cover_image_url=cover_url,
            ))
            
            if len(releases) >= limit:
                break
                
        return releases

    async def get_issue_pages(self, release: ComicRelease) -> List[ComicPage]:
        reader_url = release.raw_metadata.get("batcave_series_url") or release.reader_url
        if not reader_url:
            raise ProviderUnavailableError("No reader URL for Batcave release")
            
        async with self._browser_lock:
            if self.rate_limiter:
                await self.rate_limiter.acquire("batcave.biz")
                
            browser = await self._get_browser()
            await browser.ensure_origin(self.base_url)
            
            if self.rate_limiter:
                await self.rate_limiter.acquire("batcave.biz")
            await browser.navigate_and_wait(reader_url)
            
            comics_data = await browser.evaluate("window.__DATA__")
            if not comics_data or "chapters" not in comics_data:
                raise ProviderUnavailableError("Could not find window.__DATA__ on series page")
                
            chapters = comics_data["chapters"]
            news_id = comics_data.get("news_id")
            
            target_chapter = None
            if release.issue_number:
                for chap in chapters:
                    parsed_chap = parse_comic_title(chap["title"])
                    if parsed_chap["issue_number"] == release.issue_number:
                        target_chapter = chap
                        break
            
            if not target_chapter and chapters:
                target_chapter = chapters[0]
                
            if not target_chapter:
                return []
                
            chapter_url = f"{self.base_url}/reader/{news_id}/{target_chapter['id']}"
            if self.rate_limiter:
                await self.rate_limiter.acquire("batcave.biz")
            await browser.navigate_and_wait(chapter_url)
            
            reader_data = await browser.evaluate("window.__DATA__")
            
        if not reader_data or "images" not in reader_data:
            return []
            
        return [ComicPage(page_number=i+1, image_url=img) for i, img in enumerate(reader_data["images"])]
