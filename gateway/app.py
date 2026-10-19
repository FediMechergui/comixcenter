"""Stateless, bounded source gateway. No SQLite, local Chrome or user library is hosted here."""
import asyncio
import base64
import json
import os
import re
from urllib.parse import urlencode, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="ComixCenter gateway", version="0.2.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "OPTIONS"], allow_headers=["*"])
UA = "ComixCenter/0.2.1 (personal comics catalog)"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
CACHE = {"Cache-Control": "public, s-maxage=300, stale-while-revalidate=900"}


async def upstream(url, *, params=None, headers=None, auth=None, max_bytes=3 * 1024 * 1024):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4), follow_redirects=False) as client:
            async with client.stream("GET", url, params=params, headers={"User-Agent": UA, **(headers or {})}, auth=auth) as response:
                if response.status_code >= 300:
                    raise HTTPException(502, f"The source answered {response.status_code}. Choose another source.")
                parts, size = [], 0
                async for part in response.aiter_bytes():
                    size += len(part)
                    if size > max_bytes:
                        raise HTTPException(413, "Source response exceeds the gateway size limit")
                    parts.append(part)
                return b"".join(parts), dict(response.headers)
    except httpx.HTTPError:
        raise HTTPException(504, "The source did not answer in time. Choose another source.") from None


def source_url(url, host, prefix="/"):
    u = urlparse(url)
    if u.scheme != "https" or u.hostname != host or u.port not in (None, 443) or u.username or u.password or not u.path.startswith(prefix):
        raise HTTPException(422, "Unsupported source address")
    return url


def embedded(html):
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.find_all("script"):
        text = script.string or ""
        match = re.search(r"(?:window\.)?__DATA__\s*=\s*", text)
        if match:
            try:
                data, _ = json.JSONDecoder().raw_decode(text[match.end():])
                return data
            except (ValueError, TypeError):
                continue
    raise HTTPException(502, "The source requires browser verification. Try another source.")


def chapter_list(data):
    rows = []
    for c in data.get("chapters", []):
        if c.get("id") is None:
            continue
        title = str(c.get("title") or c["id"])
        number = re.search(r"#\s*([\d.]+[a-z]?)", title, re.I)
        rows.append({"id": str(c["id"]), "title": title, "number": number.group(1) if number else title})
    return sorted(rows, key=lambda c: float(c["number"]) if re.fullmatch(r"\d+(?:\.\d+)?", c["number"]) else float("inf"))


def rco_slug(url):
    source_url(url, "readcomicsonline.ru", "/comic/")
    slug = urlparse(url).path.split("/")[2]
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,160}", slug):
        raise HTTPException(422, "Invalid comic link")
    return slug


def rco_image_url(slug, chapter, number, pad=2):
    return f"https://cdn.readcomicsonline.ru/uploads/manga/{slug}/chapters/{chapter}/{str(number).zfill(pad)}.jpg"


async def rco_pattern(client, slug, chapter):
    async def exists(pad):
        try:
            response = await client.head(rco_image_url(slug, chapter, 1, pad))
            return pad if response.is_success and response.headers.get("content-type", "").startswith("image/") else None
        except httpx.HTTPError:
            return None
    matches = await asyncio.gather(*(exists(p) for p in (2, 3, 1)))
    return next((m for m in matches if m is not None), None)


async def rco_chapters(url, start):
    slug = rco_slug(url)
    headers = {"User-Agent": BROWSER_UA, "Referer": "https://readcomicsonline.ru/"}
    async with httpx.AsyncClient(timeout=3, headers=headers, limits=httpx.Limits(max_connections=12)) as client:
        numbers = list(range(start, start + 12))
        results = await asyncio.gather(*(rco_pattern(client, slug, str(n)) for n in numbers))
    chapters = [{"id": str(n), "title": f"Issue {n}", "number": str(n)} for n, match in zip(numbers, results) if match is not None]
    if not chapters:
        raise HTTPException(502, "ReadComicsOnline did not return any readable issues in this range. Try another source.")
    return {"url": url, "source": "rco", "chapters": chapters, "next_start": start + 12 if results[-1] is not None else None}


async def rco_pages(url, chapter):
    slug = rco_slug(url)
    if not re.fullmatch(r"[0-9]{1,5}(?:\.[0-9]{1,2})?", chapter):
        raise HTTPException(422, "Invalid issue number")
    headers = {"User-Agent": BROWSER_UA, "Referer": "https://readcomicsonline.ru/"}
    async with httpx.AsyncClient(timeout=3, headers=headers, limits=httpx.Limits(max_connections=12)) as client:
        pad = await rco_pattern(client, slug, chapter)
        if pad is None:
            raise HTTPException(502, "This issue is unavailable from ReadComicsOnline")
        pages = [rco_image_url(slug, chapter, 1, pad)]
        for start in range(2, 202, 12):
            urls = [rco_image_url(slug, chapter, n, pad) for n in range(start, min(start + 12, 201))]
            async def exists(image):
                try:
                    response = await client.head(image)
                    return response.is_success and response.headers.get("content-type", "").startswith("image/")
                except httpx.HTTPError:
                    return False
            hits = await asyncio.gather(*(exists(u) for u in urls))
            for image, hit in zip(urls, hits):
                if not hit:
                    return {"url": url, "chapter": chapter, "source": "rco", "pages": pages, "chapters": []}
                pages.append(image)
    return {"url": url, "chapter": chapter, "source": "rco", "pages": pages, "chapters": []}


async def getcomics(q, page):
    params = {"page": page, "per_page": 20, "_embed": 1}
    if q:
        params["search"] = q
    body, _ = await upstream("https://getcomics.org/wp-json/wp/v2/posts", params=params,
                             headers={"User-Agent": BROWSER_UA, "Accept": "application/json"})
    try:
        posts = json.loads(body)
    except ValueError:
        raise HTTPException(502, "GetComics returned a verification page") from None
    if not isinstance(posts, list):
        raise HTTPException(502, "GetComics returned an invalid catalog")
    entries = []
    for post in posts:
        content = BeautifulSoup(post.get("content", {}).get("rendered", ""), "html.parser")
        title = BeautifulSoup(post.get("title", {}).get("rendered", ""), "html.parser").get_text()
        media = post.get("_embedded", {}).get("wp:featuredmedia", [])
        cover = media[0].get("source_url") if media else None
        reader, files, mirrors = None, [], False
        for a in content.select("a[href]"):
            href = a["href"].replace("http://", "https://", 1)
            host = urlparse(href).hostname or ""
            if host == "readcomicsonline.ru" and urlparse(href).path.startswith("/comic/"):
                reader = href
            if re.search(r"getcomics\.|datanodes\.|pixeldrain\.|mega\.|terabox|vikingfile\.", host):
                mirrors = True
            if host in ("getcomics.org", "getcomics.info", "www.getcomics.org") and "/dls/" in href and "DOWNLOAD NOW" in a.get_text(" ", strip=True).upper():
                files.append({"href": href, "type": "application/zip"})
        if not title or not (reader or mirrors):
            continue
        entries.append({"title": title, "summary": content.get_text(" ", strip=True)[:500], "author": "GetComics", "cover": cover,
                        "kind": "publication", "href": None, "acquisitions": files, "reader_url": reader})
    return {"title": "GetComics", "source": "getcomics", "url": "getcomics://latest", "entries": entries,
            "next": str(page + 1) if len(posts) == 20 else None, "previous": str(page - 1) if page > 1 else None, "up": None}


async def batcave(q, page):
    url = "https://batcave.biz/" + ("index.php?" + urlencode({"do": "search", "subaction": "search", "story": q}) if q else f"page/{page}/" if page > 1 else "")
    body, _ = await upstream(url, headers={"User-Agent": BROWSER_UA})
    soup = BeautifulSoup(body, "html.parser")
    entries, seen = [], set()
    for item in soup.select(".latest, .readed, .poster"):
        title = item.select_one(".latest__title, .readed__title, .poster__title")
        link, img = item.select_one("a[href]"), item.select_one("img")
        if not title or not link:
            continue
        href = urljoin("https://batcave.biz/", link["href"])
        if urlparse(href).hostname != "batcave.biz" or href in seen:
            continue
        seen.add(href)
        entries.append({"title": title.get_text(" ", strip=True), "summary": None, "author": "Batcave", "cover": urljoin(url, img.get("data-src") or img.get("src", "")) if img else None,
                        "kind": "publication", "href": None, "acquisitions": [], "reader_url": href})
    if not entries:
        raise HTTPException(502, "Batcave requires a browser session. Try GetComics.")
    return {"title": "Batcave", "source": "batcave", "url": url, "entries": entries, "next": None, "previous": None, "up": None}


@app.get("/")
@app.get("/api/status")
async def status():
    return {"service": "ComixCenter source gateway", "version": "0.2.1", "stateless": True,
            "sources": {"getcomics": True, "batcave": "subject to source browser verification", "rco": True},
            "metadata": {"metron": bool(os.getenv("METRON_API_TOKEN") or os.getenv("METRON_USERNAME")), "comicvine": bool(os.getenv("COMICVINE_API_KEY")), "gcd": True}}


@app.get("/api/online/catalog")
async def catalog(response: Response, q: str = Query("", max_length=150), page: int = Query(1, ge=1, le=1000), source: str = "auto"):
    response.headers.update(CACHE)
    if source == "getcomics":
        return await getcomics(q, page)
    if source == "batcave":
        return await batcave(q, page)
    if source != "auto":
        raise HTTPException(422, "Choose auto, batcave or getcomics")
    tasks = [asyncio.create_task(getcomics(q, page)), asyncio.create_task(batcave(q, page))]
    try:
        for task in asyncio.as_completed(tasks):
            try:
                return await task
            except HTTPException:
                continue
        raise HTTPException(503, "Online sources are unavailable. Your bundled catalog and guides still work.")
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@app.get("/api/online/read/chapters")
async def chapters(url: str, start: int = Query(1, ge=1, le=10000)):
    if urlparse(url).hostname == "readcomicsonline.ru":
        try:
            return await asyncio.wait_for(rco_chapters(url, start), timeout=10)
        except TimeoutError:
            raise HTTPException(504, "This source took too long to list its issues. Try another source.") from None
    source_url(url, "batcave.biz")
    body, _ = await upstream(url, headers={"User-Agent": BROWSER_UA})
    rows = chapter_list(embedded(body))
    if not rows:
        raise HTTPException(502, "No chapters returned by the source")
    return {"url": url, "source": "batcave", "chapters": rows}


@app.get("/api/online/read/pages")
async def pages(url: str, chapter: str):
    if urlparse(url).hostname == "readcomicsonline.ru":
        try:
            return await asyncio.wait_for(rco_pages(url, chapter), timeout=12)
        except TimeoutError:
            raise HTTPException(504, "This source took too long to list its pages. Try another source.") from None
    source_url(url, "batcave.biz")
    body, _ = await upstream(url, headers={"User-Agent": BROWSER_UA})
    data = embedded(body)
    rows = chapter_list(data)
    if not chapter.isdigit() or not any(c["id"] == chapter for c in rows) or not str(data.get("news_id", "")).isdigit():
        raise HTTPException(422, "Choose a chapter from this comic")
    reader = f"https://batcave.biz/reader/{data['news_id']}/{chapter}"
    body, _ = await upstream(reader, headers={"User-Agent": BROWSER_UA})
    images = [u for u in embedded(body).get("images", []) if isinstance(u, str) and re.match(r"^https://img\.batcave\.biz/img/", u)]
    if not images:
        raise HTTPException(502, "The source returned no comic pages")
    return {"url": url, "chapter": chapter, "chapters": rows, "pages": images, "source": "batcave"}


@app.get("/api/online/read/page")
async def image(url: str):
    u = urlparse(url)
    allowed = {"img.batcave.biz": "/img/", "cdn.readcomicsonline.ru": "/uploads/manga/"}
    if u.hostname not in allowed:
        raise HTTPException(422, "Unsupported comic image host")
    source_url(url, u.hostname, allowed[u.hostname])
    content, headers = await upstream(url, headers={"User-Agent": BROWSER_UA, "Referer": f"https://{u.hostname}/"})
    mime = headers.get("content-type", "").split(";")[0]
    if not mime.startswith("image/") or mime == "image/svg+xml":
        raise HTTPException(502, "The source returned verification instead of a comic image")
    return {"base64": base64.b64encode(content).decode(), "type": mime}


@app.get("/api/upstream/{source}/{resource:path}")
async def metadata(source: str, resource: str, request: Request):
    origins = {"metron": "https://metron.cloud/api/", "comicvine": "https://comicvine.gamespot.com/api/", "gcd": "https://www.comics.org/api/"}
    if source not in origins or not re.fullmatch(r"[a-z_]+/(?:[a-zA-Z0-9_-]+/)?(?:(?:issue_list|items)/)?", resource) or len(resource) > 120:
        raise HTTPException(422, "Unsupported metadata resource")
    permitted = {"q", "name", "query", "resources", "page", "limit", "offset", "filter", "format", "sort", "year_began", "series_id", "cv_id", "number", "field_list", "publisher_id"}
    params = {k: v for k, v in request.query_params.items() if k in permitted and len(v) < 300}
    if "limit" in params:
        params["limit"] = str(min(100, max(1, int(params["limit"])))) if params["limit"].isdigit() else "20"
    headers, auth = {"Accept": "application/json"}, None
    if source == "comicvine":
        key = os.getenv("COMICVINE_API_KEY")
        if not key:
            raise HTTPException(503, "Comic Vine is not configured on this gateway")
        params.update(api_key=key, format="json")
    elif source == "metron":
        if os.getenv("METRON_API_TOKEN"):
            headers["Authorization"] = "Bearer " + os.environ["METRON_API_TOKEN"]
        elif os.getenv("METRON_USERNAME") and os.getenv("METRON_PASSWORD"):
            auth = (os.environ["METRON_USERNAME"], os.environ["METRON_PASSWORD"])
        else:
            raise HTTPException(503, "Metron is not configured on this gateway")
    content, _ = await upstream(origins[source] + resource, params=params, headers=headers, auth=auth)
    try:
        return json.loads(content)
    except ValueError:
        raise HTTPException(502, "The metadata source returned an invalid response") from None
