"""Bringing files into the library: uploads, folder scans and OPDS downloads all end here."""
import hashlib
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from comix.config import get_settings
from comix.library.archives import SUPPORTED_EXTENSIONS, ArchiveError, detect_format, open_archive
from comix.library.comicinfo import read_embedded_metadata
from comix.library.imaging import images_to_pdf
from comix.library.matching import apply_match, guess_from_filename
from comix.bootstrap import DEFAULT_USER_ID
from comix.models import LibraryFile, ReadStatus


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def page_cache_dir(lf: LibraryFile) -> Path:
    return get_settings().cache_dir / "pages" / lf.sha256[:2] / lf.sha256


def open_file(lf: LibraryFile):
    return open_archive(Path(lf.path), lf.format, page_cache_dir(lf))


def import_file(session: Session, source: Path, original_name: Optional[str] = None, managed: bool = True,
                opds_feed_id: Optional[int] = None) -> Tuple[LibraryFile, bool]:
    """
    Adds a file to the library and matches it to the catalog. Returns (file, created).
    managed=True copies it into the library directory; False references it where it is (folder scans).
    The same content imported twice is detected by hash.
    """
    source = Path(source)
    digest = sha256_of(source)
    existing = session.scalar(select(LibraryFile).where(LibraryFile.sha256 == digest))
    if existing is not None:
        return existing, False

    fmt = detect_format(source)
    name = original_name or source.name
    if managed:
        ext = {"cbz": ".cbz", "cbr": ".cbr", "cb7": ".cb7", "pdf": ".pdf", "epub": ".epub"}[fmt]
        target = get_settings().library_dir / digest[:2] / f"{digest}{ext}"
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copyfile(source, target)
        stored = target
    else:
        stored = source.resolve()

    lf = LibraryFile(path=str(stored), managed=managed, original_name=name, format=fmt,
                     size=stored.stat().st_size, sha256=digest, opds_feed_id=opds_feed_id)
    try:
        archive = open_file(lf)
        try:
            lf.page_count = archive.page_count
            info = read_embedded_metadata(archive.metadata_files())
        finally:
            archive.close()
    except ArchiveError:
        if managed and stored.exists():
            stored.unlink()
        raise
    if lf.page_count == 0:
        if managed and stored.exists():
            stored.unlink()
        raise ArchiveError(f"{name} contains no pages")
    lf.comicinfo = info or None
    lf.parsed = guess_from_filename(name)
    session.add(lf)
    session.flush()
    apply_match(session, lf)
    return lf, True


def scan_directories(session: Session, directories: Iterable[Path]) -> Dict[str, object]:
    """Imports every supported file under the given folders, referencing them in place."""
    added: List[int] = []
    errors: List[Dict[str, str]] = []
    seen = 0
    known_paths = set(session.scalars(select(LibraryFile.path)))
    for directory in directories:
        directory = Path(directory)
        if not directory.is_dir():
            errors.append({"path": str(directory), "error": "not a folder"})
            continue
        for root, _dirs, files in os.walk(directory):
            for fname in files:
                path = Path(root) / fname
                if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                    continue
                seen += 1
                if str(path.resolve()) in known_paths:
                    continue
                try:
                    with session.begin_nested():
                        lf, created = import_file(session, path, managed=False)
                    if created:
                        added.append(lf.id)
                except (ArchiveError, OSError) as exc:
                    errors.append({"path": str(path), "error": str(exc)})
    return {"seen": seen, "added": len(added), "file_ids": added, "errors": errors}


def remove_file(session: Session, lf: LibraryFile) -> None:
    cache = page_cache_dir(lf)
    if cache.exists():
        shutil.rmtree(cache, ignore_errors=True)
    if lf.managed:
        Path(lf.path).unlink(missing_ok=True)
    session.delete(lf)


def export_pdf(lf: LibraryFile) -> bytes:
    """PDF of a file the user owns: the original for PDFs, otherwise pages via img2pdf (lossless JPEG)."""
    if lf.format == "pdf":
        return Path(lf.path).read_bytes()
    archive = open_file(lf)
    try:
        return images_to_pdf(archive.page(i)[0] for i in range(archive.page_count))
    finally:
        archive.close()


def record_position(session: Session, lf: LibraryFile, page: int, user_id: int = DEFAULT_USER_ID) -> bool:
    """Saves the reading position; reaching the last page marks the linked issue read. Returns finished."""
    now = datetime.now(timezone.utc)
    lf.current_page = max(0, min(page, max(lf.page_count - 1, 0)))
    lf.last_read_at = now
    finished = lf.page_count > 0 and lf.current_page >= lf.page_count - 1
    if finished:
        lf.finished_at = lf.finished_at or now
        if lf.issue_id and session.get(ReadStatus, (user_id, lf.issue_id)) is None:
            session.add(ReadStatus(user_id=user_id, issue_id=lf.issue_id, read_at=now))
    session.flush()
    return finished
