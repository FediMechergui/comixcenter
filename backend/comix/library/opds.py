"""
OPDS 1.x catalog client: browse a feed (navigation + publications) and import a book you own
or that the catalog offers openly. Komga, Kavita, Calibre-Web and Ubooquity all serve OPDS.
"""
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx

ATOM = "{http://www.w3.org/2005/Atom}"
ACQUISITION = "http://opds-spec.org/acquisition"
COMIC_TYPES = ("application/vnd.comicbook+zip", "application/x-cbz", "application/zip", "application/x-cbr",
               "application/vnd.comicbook-rar", "application/x-rar-compressed", "application/x-cb7",
               "application/x-7z-compressed", "application/pdf", "application/epub+zip", "application/octet-stream")
IMAGE_RELS = ("http://opds-spec.org/image", "http://opds-spec.org/cover", "http://opds-spec.org/image/thumbnail",
              "http://opds-spec.org/thumbnail")
MAX_DOWNLOAD = 2 * 1024 ** 3


class OpdsError(RuntimeError):
    pass


def _check_url(url: str) -> str:
    if urlparse(url).scheme not in ("http", "https"):
        raise OpdsError("Only http(s) OPDS URLs are supported")
    return url


def _client(username: Optional[str], password: Optional[str]) -> httpx.Client:
    auth = (username, password) if username else None
    return httpx.Client(auth=auth, timeout=30, follow_redirects=True,
                        headers={"User-Agent": "ComixCenter/0.1", "Accept": "application/atom+xml, */*"})


def parse_feed(xml_bytes: bytes, base_url: str) -> Dict[str, Any]:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise OpdsError(f"Not an OPDS/Atom feed: {exc}") from exc
    if root.tag != f"{ATOM}feed":
        raise OpdsError("Not an OPDS/Atom feed")

    def link_href(el: ET.Element, rel: str) -> Optional[str]:
        for link in el.iterfind(f"{ATOM}link"):
            if link.get("rel") == rel:
                return urljoin(base_url, link.get("href", ""))
        return None

    entries: List[Dict[str, Any]] = []
    for entry in root.iterfind(f"{ATOM}entry"):
        title = (entry.findtext(f"{ATOM}title") or "Untitled").strip()
        summary = (entry.findtext(f"{ATOM}summary") or entry.findtext(f"{ATOM}content") or "").strip() or None
        author = entry.findtext(f"{ATOM}author/{ATOM}name")
        acquisitions, navigation, cover = [], None, None
        for link in entry.iterfind(f"{ATOM}link"):
            rel, href, typ = link.get("rel") or "", link.get("href"), (link.get("type") or "").split(";")[0].strip()
            if not href:
                continue
            absolute = urljoin(base_url, href)
            if rel.startswith(ACQUISITION) and not rel.endswith(("/buy", "/borrow", "/subscribe", "/sample")):
                acquisitions.append({"href": absolute, "type": typ or None, "rel": rel})
            elif rel in IMAGE_RELS and (cover is None or rel.endswith(("image", "cover"))):
                cover = absolute
            elif "atom+xml" in typ and rel in ("subsection", "alternate", "", "http://opds-spec.org/sort/new",
                                               "http://opds-spec.org/sort/popular") or (
                    "profile=opds-catalog" in (link.get("type") or "")):
                navigation = navigation or absolute
        entries.append({
            "title": title, "summary": summary, "author": author, "cover": cover,
            "kind": "publication" if acquisitions else "navigation",
            "href": navigation, "acquisitions": acquisitions,
        })
    return {
        "title": (root.findtext(f"{ATOM}title") or "").strip(),
        "entries": entries,
        "next": link_href(root, "next"),
        "previous": link_href(root, "previous"),
        "up": link_href(root, "up") or link_href(root, "start"),
    }


def browse(url: str, username: Optional[str] = None, password: Optional[str] = None) -> Dict[str, Any]:
    with _client(username, password) as client:
        resp = client.get(_check_url(url))
        resp.raise_for_status()
        feed = parse_feed(resp.content, str(resp.url))
    feed["url"] = url
    return feed


def download(url: str, username: Optional[str] = None, password: Optional[str] = None) -> Path:
    """Streams an acquisition link to a temp file (caller deletes it)."""
    fd, tmp = tempfile.mkstemp(prefix="comix-opds-")
    size = 0
    try:
        with open(fd, "wb") as out, _client(username, password) as client, client.stream("GET", _check_url(url)) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_bytes(1 << 20):
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    raise OpdsError("Download exceeds 2 GB")
                out.write(chunk)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return Path(tmp)
