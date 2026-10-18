"""Batcave catalog and reader through a normal browser session, with bounded caching."""
import asyncio
import base64
import hashlib
import json
import re
import time
from urllib.parse import urlencode, urljoin, urlparse

from bs4 import BeautifulSoup

from app.browser.cdp import ChromeBrowser
from comix.config import BACKEND_DIR, get_settings

ORIGIN = "https://batcave.biz"
MAX_IMAGE = 20 * 1024 * 1024


def checked_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "batcave.biz" or parsed.username or parsed.password:
        raise ValueError("Choose a comic from Batcave to read")
    return url


def parse_catalog(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    entries, seen = [], set()
    for item in soup.select(".latest, .readed, .short, .poster"):
        title = item.select_one(".latest__title, .readed__title, .short__title, .poster__title")
        link = item.select_one("a[href]")
        if not title or not link:
            continue
        href = urljoin(ORIGIN, link["href"])
        if urlparse(href).hostname != "batcave.biz" or href in seen:
            continue
        seen.add(href)
        image = item.select_one("img")
        chapter = item.select_one(".latest__chapter")
        label = re.sub(r"^\d{2}\.\d{2}\.\d{4}\s*[-–]\s*", "", chapter.get_text(" ", strip=True)) if chapter else title.get_text(" ", strip=True)
        entries.append({"title": label, "summary": None, "author": "Batcave", "cover": urljoin(ORIGIN, image.get("data-src") or image.get("src", "")) if image else None,
                        "kind": "publication", "href": None, "acquisitions": [], "reader_url": href})
    return entries


def normalize_chapters(data: dict) -> list[dict]:
    chapters = []
    for chapter in data.get("chapters", []):
        if chapter.get("id") is None:
            continue
        label = str(chapter.get("title") or chapter.get("name") or chapter["id"])
        match = re.search(r"#\s*([\d.]+[a-z]?)", label, re.I)
        chapters.append({"id": str(chapter["id"]), "title": label, "number": match.group(1) if match else label})
    def key(c):
        return [float(p) if re.fullmatch(r"\d+(?:\.\d+)?", p) else p.lower() for p in re.split(r"(\d+(?:\.\d+)?)", c["number"])]
    return sorted(chapters, key=key)


class OnlineReader:
    def __init__(self):
        self.browser = None
        self.lock = asyncio.Lock()
        self.cache: dict[str, tuple[float, object]] = {}
        self.images: dict[str, tuple[float, str]] = {}

    async def _browser(self):
        if self.browser is None:
            existing = BACKEND_DIR / "scratch" / "chrome_profile"
            profile = existing if existing.is_dir() else get_settings().data_dir / "browser" / "batcave"
            self.browser = ChromeBrowser(str(profile), port=9333)
        await self.browser.start(ORIGIN + "/")
        if not self.cache:
            await self.browser.navigate_and_wait(ORIGIN + "/", timeout=20)
        await self.browser.ensure_origin(ORIGIN, timeout=25)
        return self.browser

    async def document(self, url: str) -> tuple[str, dict]:
        checked_url(url)
        async with self.lock:
            hit = self.cache.get(url)
            if hit and hit[0] > time.monotonic():
                return hit[1]
            browser = await self._browser()
            await browser.navigate_and_wait(url, timeout=20)
            html = await browser.evaluate("document.documentElement.outerHTML")
            data = await browser.evaluate("window.__DATA__ || null")
            title = await browser.evaluate("document.title")
            if not html or "Just a moment" in (title or ""):
                raise RuntimeError("Batcave needs verification. Complete the check in the ComixCenter browser window, then retry.")
            value = (html, data if isinstance(data, dict) else {})
            # Metadata is ready at DOMContentLoaded; the source reader otherwise downloads every
            # full-resolution page in the background before the app can open its own reader.
            await (await browser.page()).send("Page.stopLoading")
            if len(self.cache) >= 64:
                self.cache.pop(next(iter(self.cache)))
            self.cache[url] = (time.monotonic() + 300, value)
            return value

    async def catalog(self, q: str = "", page: int = 1):
        if q:
            url = ORIGIN + "/index.php?" + urlencode({"do": "search", "subaction": "search", "story": q, "search_start": page})
        else:
            url = ORIGIN + (f"/page/{page}/" if page > 1 else "/")
        html, _ = await self.document(url)
        entries = parse_catalog(html)
        for entry in entries:
            if entry["cover"]:
                entry["cover"] = "/api/online/cover?" + urlencode({"url": entry["cover"]})
        soup = BeautifulSoup(html, "html.parser")
        next_link = soup.select_one('a[rel="next"], .pagination__next a, a.pagination__next')
        # DLE pagination often uses plain numeric links.
        has_next = bool(next_link) or any(a.get_text(strip=True) == str(page + 1) for a in soup.select(".pagination a, .navigation a, .pagination__pages a"))
        return {"title": "Batcave", "url": url, "entries": entries, "next": str(page + 1) if has_next else None,
                "previous": str(page - 1) if page > 1 else None, "up": None}

    async def chapters(self, url: str):
        _, data = await self.document(url)
        chapters = normalize_chapters(data)
        if not chapters or not data.get("news_id"):
            raise RuntimeError("Batcave did not return a chapter list for this comic. Retry after checking the source browser.")
        return {"url": url, "chapters": chapters, "source": "batcave"}

    async def pages(self, url: str, chapter: str):
        _, data = await self.document(url)
        chapters = normalize_chapters(data)
        selected = next((c for c in chapters if c["id"] == chapter), None)
        if not selected or not str(data.get("news_id", "")).isdigit() or not chapter.isdigit():
            raise ValueError("That chapter is not in this comic")
        reader_url = f"{ORIGIN}/reader/{data['news_id']}/{chapter}"
        _, reader = await self.document(reader_url)
        images = reader.get("images", [])
        pages = []
        for img in images:
            value = img if isinstance(img, str) else (img.get("url") or img.get("src")) if isinstance(img, dict) else None
            if not value:
                continue
            image_url = urljoin(ORIGIN, value)
            parsed = urlparse(image_url)
            if parsed.scheme != "https" or parsed.hostname != "img.batcave.biz" or parsed.username or parsed.password:
                continue
            pages.append(image_url)
            self.images[image_url] = (time.monotonic() + 3600, reader_url)
        self.images = {u: v for u, v in self.images.items() if v[0] > time.monotonic()}
        if not pages:
            raise RuntimeError("Batcave returned no pages for this chapter")
        return {"url": url, "chapter": chapter, "pages": pages, "chapters": chapters, "source": "batcave"}

    async def image(self, url: str):
        registered = self.images.get(url)
        if not registered or registered[0] < time.monotonic():
            raise ValueError("Open the chapter before requesting its pages")
        return await self.browser_image(url)

    async def cover(self, url: str):
        checked_url(url)
        parsed = urlparse(url)
        if not re.fullmatch(r"/uploads/(?:mini|posts)/[a-zA-Z0-9/_.-]+\.(?:webp|jpe?g|png)", parsed.path):
            raise ValueError("That is not a Batcave cover")
        path = get_settings().cache_dir / "online-covers" / hashlib.sha256(url.encode()).hexdigest()
        if path.is_file() and time.time() - path.stat().st_mtime < 7 * 86400:
            return path.read_bytes()
        image = await self.browser_image(url)
        content = base64.b64decode(image["base64"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return content

    async def browser_image(self, url: str):
        async with self.lock:
            if self.browser is None:
                await self._browser()
            browser = self.browser
            await browser.start(ORIGIN + "/")
            if urlparse(await browser.current_url()).hostname != urlparse(url).hostname:
                await browser.navigate_and_wait(url, timeout=20)
            expression = """(async () => {
                const r = await fetch(URL_VALUE);
                const type = (r.headers.get('content-type') || '').split(';')[0];
                if (!r.ok || !type.startsWith('image/')) throw new Error('Batcave image needs verification in the source browser');
                const reader = r.body.getReader(); const chunks = []; let size = 0;
                try { while (true) { const {done, value} = await reader.read(); if (done) break;
                    size += value.length; if (size > 20 * 1024 * 1024) throw new Error('Image exceeds 20 MB'); chunks.push(value); }
                } finally { await reader.cancel(); }
                let binary = ''; for (const chunk of chunks) { for (let i = 0; i < chunk.length; i += 32768)
                    binary += String.fromCharCode(...chunk.subarray(i, i + 32768)); }
                return {base64: btoa(binary), type};
            })()""".replace("URL_VALUE", json.dumps(url))
            return await browser.evaluate(expression, timeout=60)

    async def close(self):
        if self.browser:
            await self.browser.close()


online_reader = OnlineReader()
