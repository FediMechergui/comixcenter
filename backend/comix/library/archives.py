"""
One page-oriented interface over the comic formats people own: CBZ, CBR, CB7, PDF and EPUB.

CBZ and EPUB are read in place. CBR / CB7 (solid archives, slow to seek) are extracted once into
the page cache. PDF pages are rendered to JPEG with PyMuPDF on first use and cached.
"""
import io
import posixpath
import shutil
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import unquote

from comix.library.imaging import IMAGE_MIME_TYPES, detect_image_extension, is_page_image, natural_sort_key

SUPPORTED_EXTENSIONS = {".cbz", ".cbr", ".cb7", ".pdf", ".epub", ".zip", ".rar", ".7z"}


class ArchiveError(RuntimeError):
    pass


def detect_format(path: Path) -> str:
    """cbz / cbr / cb7 / pdf / epub from the file's magic bytes (extensions lie: many .cbr are zips)."""
    with open(path, "rb") as f:
        head = f.read(64)
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"Rar!\x1a\x07"):
        return "cbr"
    if head.startswith(b"7z\xbc\xaf\x27\x1c"):
        return "cb7"
    if head.startswith(b"PK"):
        try:
            with zipfile.ZipFile(path) as zf:
                names = set(zf.namelist())
                if "mimetype" in names and zf.read("mimetype").strip() == b"application/epub+zip":
                    return "epub"
                if "META-INF/container.xml" in names and any(n.endswith(".opf") for n in names):
                    return "epub"
        except zipfile.BadZipFile as exc:
            raise ArchiveError(f"Corrupt zip archive: {exc}") from exc
        return "cbz"
    raise ArchiveError(f"Unsupported or unrecognised file format: {path.name}")


def _mime(data: bytes) -> str:
    return IMAGE_MIME_TYPES.get(detect_image_extension(data), "application/octet-stream")


class ComicArchive:
    """Pages are addressed by index (0-based)."""
    page_count: int = 0

    def page(self, index: int) -> Tuple[bytes, str]:
        raise NotImplementedError

    def metadata_files(self) -> dict:
        """Raw ComicInfo.xml / MetronInfo.xml bytes when present."""
        return {}

    def close(self) -> None:
        pass

    def _check(self, index: int) -> None:
        if not 0 <= index < self.page_count:
            raise IndexError(f"page {index} out of range (0..{self.page_count - 1})")


class ZipComic(ComicArchive):
    def __init__(self, path: Path):
        self.zf = zipfile.ZipFile(path)
        self.names = sorted((n for n in self.zf.namelist() if is_page_image(n)), key=natural_sort_key)
        self.page_count = len(self.names)

    def page(self, index: int) -> Tuple[bytes, str]:
        self._check(index)
        data = self.zf.read(self.names[index])
        return data, _mime(data)

    def metadata_files(self) -> dict:
        found = {}
        for name in self.zf.namelist():
            base = name.rsplit("/", 1)[-1].lower()
            if base in ("comicinfo.xml", "metroninfo.xml"):
                found[base] = self.zf.read(name)
        return found

    def close(self) -> None:
        self.zf.close()


class EpubComic(ZipComic):
    """Comic EPUBs: one image per spine document, in spine order (falls back to all images)."""

    def __init__(self, path: Path):
        super().__init__(path)
        spine_images = self._spine_images()
        if spine_images:
            self.names = spine_images
            self.page_count = len(spine_images)

    def _spine_images(self) -> List[str]:
        try:
            container = ET.fromstring(self.zf.read("META-INF/container.xml"))
            rootfile = container.find(".//{*}rootfile").get("full-path")
            opf = ET.fromstring(self.zf.read(rootfile))
        except (KeyError, AttributeError, ET.ParseError):
            return []
        base = posixpath.dirname(rootfile)
        manifest = {item.get("id"): item for item in opf.iterfind(".//{*}manifest/{*}item")}
        names = set(self.zf.namelist())
        images: List[str] = []
        for ref in opf.iterfind(".//{*}spine/{*}itemref"):
            item = manifest.get(ref.get("idref"))
            if item is None:
                continue
            href = posixpath.normpath(posixpath.join(base, unquote(item.get("href", ""))))
            media = item.get("media-type", "")
            if media.startswith("image/") and href in names:
                images.append(href)
                continue
            if href not in names:
                continue
            try:
                doc = ET.fromstring(self.zf.read(href))
            except ET.ParseError:
                continue
            doc_dir = posixpath.dirname(href)
            for el in doc.iter():
                tag = el.tag.rsplit("}", 1)[-1]
                src = el.get("src") if tag == "img" else (
                    el.get("{http://www.w3.org/1999/xlink}href") or el.get("href") if tag == "image" else None)
                if src:
                    target = posixpath.normpath(posixpath.join(doc_dir, unquote(src)))
                    if target in names and target not in images:
                        images.append(target)
                    break
        return images


class ExtractedComic(ComicArchive):
    """CBR / CB7: extracted once into a cache directory, then read like a folder of images."""

    def __init__(self, path: Path, fmt: str, cache_dir: Path):
        self.dir = cache_dir
        marker = cache_dir / ".complete"
        if not marker.exists():
            if cache_dir.exists():
                shutil.rmtree(cache_dir)
            cache_dir.mkdir(parents=True)
            (_extract_rar if fmt == "cbr" else _extract_7z)(path, cache_dir)
            marker.touch()
        files = [p for p in cache_dir.rglob("*") if p.is_file() and is_page_image(p.relative_to(cache_dir).as_posix())]
        self.files = sorted(files, key=lambda p: natural_sort_key(p.relative_to(cache_dir).as_posix()))
        self.page_count = len(self.files)

    def page(self, index: int) -> Tuple[bytes, str]:
        self._check(index)
        data = self.files[index].read_bytes()
        return data, _mime(data)

    def metadata_files(self) -> dict:
        found = {}
        for p in self.dir.rglob("*"):
            if p.name.lower() in ("comicinfo.xml", "metroninfo.xml"):
                found[p.name.lower()] = p.read_bytes()
        return found


def _extract_7z(path: Path, dest: Path) -> None:
    import py7zr
    with py7zr.SevenZipFile(path) as archive:
        archive.extractall(path=dest)


@lru_cache
def _rar_tool() -> Optional[List[str]]:
    """unrar, 7z, or bsdtar (libarchive reads RAR4/RAR5; Windows 10+ ships it as tar.exe)."""
    for name in ("unrar", "UnRAR"):
        exe = shutil.which(name)
        if exe:
            return [exe, "x", "-o+", "-idq"]
    for name in ("7z", "7za", "7zz"):
        exe = shutil.which(name)
        if exe:
            return [exe, "x", "-y", "-bd"]
    candidates = [shutil.which("bsdtar")]
    if sys.platform == "win32":
        candidates.append(r"C:\Windows\System32\tar.exe")
    candidates.append(shutil.which("tar"))
    for exe in filter(None, candidates):
        try:
            version = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        if "bsdtar" in version or "libarchive" in version:
            return [exe, "-xf"]
    return None


def _extract_rar(path: Path, dest: Path) -> None:
    tool = _rar_tool()
    if tool is None:
        raise ArchiveError("No RAR extractor found. Install unrar, 7-Zip or bsdtar (libarchive) to read CBR files.")
    exe = Path(tool[0]).name.lower()
    if exe.startswith("unrar"):
        cmd = tool + [str(path), str(dest) + "/"]
    elif exe.startswith("7z"):
        cmd = tool + [str(path), f"-o{dest}"]
    else:
        cmd = tool + [str(path), "-C", str(dest)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise ArchiveError(f"Could not extract RAR archive: {proc.stderr.strip()[:300]}")


class PdfComic(ComicArchive):
    """PDF pages rendered to JPEG (long side ~2000 px) with PyMuPDF and cached on disk."""

    TARGET_LONG_SIDE = 2000

    def __init__(self, path: Path, cache_dir: Path):
        import pymupdf
        self.doc = pymupdf.open(path)
        self.page_count = self.doc.page_count
        self.cache_dir = cache_dir

    def page(self, index: int) -> Tuple[bytes, str]:
        self._check(index)
        cached = self.cache_dir / f"{index:05d}.jpg"
        if cached.exists():
            return cached.read_bytes(), "image/jpeg"
        import pymupdf
        pg = self.doc[index]
        long_side = max(pg.rect.width, pg.rect.height) or 1
        zoom = min(4.0, self.TARGET_LONG_SIDE / long_side)
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        data = pix.tobytes("jpg", jpg_quality=88)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(data)
        return data, "image/jpeg"

    def metadata_files(self) -> dict:
        meta = self.doc.metadata or {}
        return {"pdf": meta}

    def close(self) -> None:
        self.doc.close()


def open_archive(path: Path, fmt: str, cache_dir: Path) -> ComicArchive:
    if fmt == "cbz":
        return ZipComic(path)
    if fmt == "epub":
        return EpubComic(path)
    if fmt in ("cbr", "cb7"):
        return ExtractedComic(path, fmt, cache_dir / "extracted")
    if fmt == "pdf":
        return PdfComic(path, cache_dir / "rendered")
    raise ArchiveError(f"Unsupported format {fmt}")
