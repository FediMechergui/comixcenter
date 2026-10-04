"""Library, reader and OPDS endpoints."""
import io
import shutil
import tempfile
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from comix.api.deps import DB, found
from comix.config import get_settings
from comix.library import opds
from comix.library.archives import ArchiveError
from comix.library.importer import (
    export_pdf, import_file, open_file, page_cache_dir, record_position, remove_file, scan_directories,
)
from comix.library.matching import apply_match
from comix.library.panels import detect_panels
from comix.models import Issue, LibraryFile, OpdsFeed, PagePanels, Series
from comix.services.catalog import issue_card

router = APIRouter(prefix="/api/library", tags=["library"])
opds_router = APIRouter(prefix="/api/opds", tags=["library"])

CACHE_HEADERS = {"Cache-Control": "public, max-age=604800, immutable"}
ALLOWED_WIDTHS = (320, 480, 640, 800, 1080, 1280, 1600, 2048)


def file_card(db: Session, lf: LibraryFile) -> dict:
    issue = db.get(Issue, lf.issue_id) if lf.issue_id else None
    return {"id": lf.id, "name": lf.original_name, "format": lf.format, "size": lf.size, "page_count": lf.page_count,
            "current_page": lf.current_page, "finished": lf.finished_at is not None, "added_at": lf.added_at,
            "last_read_at": lf.last_read_at, "managed": lf.managed,
            "match_method": lf.match_method, "match_confidence": lf.match_confidence,
            "issue": issue_card(issue) if issue else None,
            "candidates": (lf.parsed or {}).get("candidates", []),
            "parsed": {k: v for k, v in (lf.parsed or {}).items() if k in ("series", "number", "year", "volume")},
            "comicinfo": {k: v for k, v in (lf.comicinfo or {}).items() if k in ("Series", "Number", "Year", "Volume", "Title", "ids")},
            "cover_url": f"/api/library/{lf.id}/pages/0?w=480"}


@router.get("")
def library(q: Optional[str] = None, status: Literal["all", "matched", "unmatched", "reading", "finished"] = "all",
            sort: Literal["added", "name", "read"] = "added", page: int = 1, size: int = 60, db: Session = DB):
    query = select(LibraryFile)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(LibraryFile.original_name.ilike(like), LibraryFile.issue_id.in_(
            select(Issue.id).join(Series, Series.id == Issue.series_id).where(Series.name.ilike(like)))))
    if status == "matched":
        query = query.where(LibraryFile.issue_id.is_not(None))
    elif status == "unmatched":
        query = query.where(LibraryFile.issue_id.is_(None))
    elif status == "reading":
        query = query.where(LibraryFile.current_page > 0, LibraryFile.finished_at.is_(None))
    elif status == "finished":
        query = query.where(LibraryFile.finished_at.is_not(None))
    order = {"name": LibraryFile.original_name, "read": LibraryFile.last_read_at.desc().nulls_last()}.get(
        sort, LibraryFile.added_at.desc())
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(order).offset((max(page, 1) - 1) * size).limit(size)).all()
    counts = {
        "all": db.scalar(select(func.count()).select_from(LibraryFile)),
        "unmatched": db.scalar(select(func.count()).select_from(LibraryFile).where(LibraryFile.issue_id.is_(None))),
    }
    return {"items": [file_card(db, lf) for lf in rows], "total": total, "page": page, "size": size, "counts": counts}


@router.post("/upload")
async def upload(files: List[UploadFile] = File(...), db: Session = DB):
    results = []
    for upload_file in files:
        suffix = Path(upload_file.filename or "upload").suffix
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(upload_file.file, tmp)
            tmp_path = Path(tmp.name)
        try:
            lf, created = import_file(db, tmp_path, original_name=upload_file.filename or tmp_path.name)
            db.commit()
            results.append({"name": upload_file.filename, "ok": True, "created": created, "file": file_card(db, lf)})
        except (ArchiveError, OSError) as exc:
            db.rollback()
            results.append({"name": upload_file.filename, "ok": False, "error": str(exc)})
        finally:
            tmp_path.unlink(missing_ok=True)
    return {"results": results}


class ScanRequest(BaseModel):
    paths: Optional[List[str]] = None


@router.post("/scan")
def scan(body: ScanRequest, db: Session = DB):
    """Imports owned files from server folders (COMIX_SCAN_DIRS by default), referencing them in place."""
    dirs = [Path(p) for p in body.paths] if body.paths else get_settings().scan_dirs
    if not dirs:
        raise HTTPException(400, "No folders given and COMIX_SCAN_DIRS is not set")
    result = scan_directories(db, dirs)
    db.commit()
    return result


@router.get("/{file_id}")
def library_file(file_id: int, db: Session = DB):
    return file_card(db, found(db.get(LibraryFile, file_id), "File not found"))


class MatchUpdate(BaseModel):
    issue_id: Optional[int] = None   # None clears a manual match and lets auto-matching run again


@router.patch("/{file_id}")
def set_match(file_id: int, body: MatchUpdate, db: Session = DB):
    lf = found(db.get(LibraryFile, file_id), "File not found")
    if body.issue_id is not None:
        found(db.get(Issue, body.issue_id), "Issue not found")
        lf.issue_id, lf.match_method, lf.match_confidence = body.issue_id, "manual", 1.0
    else:
        lf.match_method = None
        apply_match(db, lf)
    db.commit()
    return file_card(db, lf)


@router.post("/{file_id}/rematch")
def rematch(file_id: int, db: Session = DB):
    lf = found(db.get(LibraryFile, file_id), "File not found")
    if lf.match_method == "manual":
        lf.match_method = None
    apply_match(db, lf)
    db.commit()
    return file_card(db, lf)


@router.delete("/{file_id}")
def delete_file(file_id: int, db: Session = DB):
    lf = found(db.get(LibraryFile, file_id), "File not found")
    remove_file(db, lf)
    db.commit()
    return {"deleted": file_id}


@router.get("/{file_id}/pages/{index}")
def page_image(file_id: int, index: int, request: Request, w: Optional[int] = Query(default=None), db: Session = DB):
    """A page image; `w` resizes (snapped to standard widths) for phones and thumbnails, cached on disk."""
    lf = found(db.get(LibraryFile, file_id), "File not found")
    if not 0 <= index < lf.page_count:
        raise HTTPException(404, "Page out of range")
    etag = f'"{lf.sha256[:16]}-{index}-{w or 0}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, **CACHE_HEADERS})
    if w:
        width = min(ALLOWED_WIDTHS, key=lambda a: abs(a - w))
        cached = page_cache_dir(lf) / f"w{width}" / f"{index:05d}.jpg"
        if not cached.exists():
            data, _ = _read_page(lf, index)
            with Image.open(io.BytesIO(data)) as img:
                if img.width > width:
                    img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
                out = io.BytesIO()
                img.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(out.getvalue())
        return Response(cached.read_bytes(), media_type="image/jpeg", headers={"ETag": etag, **CACHE_HEADERS})
    data, mime = _read_page(lf, index)
    return Response(data, media_type=mime, headers={"ETag": etag, **CACHE_HEADERS})


def _read_page(lf: LibraryFile, index: int):
    archive = open_file(lf)
    try:
        return archive.page(index)
    finally:
        archive.close()


@router.get("/{file_id}/pages/{index}/panels")
def page_panels(file_id: int, index: int, rtl: bool = False, db: Session = DB):
    lf = found(db.get(LibraryFile, file_id), "File not found")
    if not 0 <= index < lf.page_count:
        raise HTTPException(404, "Page out of range")
    cached = db.get(PagePanels, (file_id, index))
    if cached is None:
        width, height, panels = detect_panels(_read_page(lf, index)[0])
        cached = PagePanels(file_id=file_id, page_index=index, width=width, height=height, panels=panels)
        db.add(cached)
        db.commit()
    panels = cached.panels
    if rtl:
        # Re-sort right-to-left within rows: panels whose tops are close share a row
        rows: list = []
        for p in sorted(panels, key=lambda p: p[1]):
            if rows and abs(rows[-1][0][1] - p[1]) < 0.05:
                rows[-1].append(p)
            else:
                rows.append([p])
        panels = [p for row in rows for p in sorted(row, key=lambda p: -p[0])]
    return {"width": cached.width, "height": cached.height, "panels": panels}


class Position(BaseModel):
    page: int


@router.put("/{file_id}/position")
def position(file_id: int, body: Position, db: Session = DB):
    lf = found(db.get(LibraryFile, file_id), "File not found")
    finished = record_position(db, lf, body.page)
    db.commit()
    return {"current_page": lf.current_page, "finished": finished, "issue_id": lf.issue_id}


@router.get("/{file_id}/export.pdf")
def pdf_export(file_id: int, db: Session = DB):
    lf = found(db.get(LibraryFile, file_id), "File not found")
    name = Path(lf.original_name).stem + ".pdf"
    safe = "".join(ch if ch.isalnum() or ch in " ._-()#" else "_" for ch in name)
    return Response(export_pdf(lf), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{safe}"'})


# ── OPDS ──
class FeedIn(BaseModel):
    name: str
    url: str
    username: Optional[str] = None
    password: Optional[str] = None


def feed_card(f: OpdsFeed) -> dict:
    return {"id": f.id, "name": f.name, "url": f.url, "username": f.username, "has_password": bool(f.password)}


@opds_router.get("")
def feeds(db: Session = DB):
    return [feed_card(f) for f in db.scalars(select(OpdsFeed).order_by(OpdsFeed.name))]


@opds_router.post("")
def add_feed(body: FeedIn, db: Session = DB):
    try:
        opds.browse(body.url, body.username, body.password)
    except Exception as exc:  # noqa: BLE001 - surface any connection/parse problem to the user
        raise HTTPException(400, f"Could not read that OPDS feed: {exc}")
    feed = OpdsFeed(name=body.name, url=body.url, username=body.username or None, password=body.password or None)
    db.add(feed)
    db.commit()
    return feed_card(feed)


@opds_router.delete("/{feed_id}")
def delete_feed(feed_id: int, db: Session = DB):
    db.delete(found(db.get(OpdsFeed, feed_id), "Feed not found"))
    db.commit()
    return {"deleted": feed_id}


@opds_router.get("/{feed_id}/browse")
def browse_feed(feed_id: int, url: Optional[str] = None, db: Session = DB):
    feed = found(db.get(OpdsFeed, feed_id), "Feed not found")
    try:
        return opds.browse(url or feed.url, feed.username, feed.password)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"OPDS feed error: {exc}")


class OpdsImport(BaseModel):
    href: str
    title: Optional[str] = None


@opds_router.post("/{feed_id}/import")
def import_from_feed(feed_id: int, body: OpdsImport, db: Session = DB):
    feed = found(db.get(OpdsFeed, feed_id), "Feed not found")
    try:
        tmp = opds.download(body.href, feed.username, feed.password)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Download failed: {exc}")
    try:
        name = (body.title or Path(body.href).name or "opds-book")
        lf, created = import_file(db, tmp, original_name=name, opds_feed_id=feed.id)
        db.commit()
        return {"created": created, "file": file_card(db, lf)}
    except ArchiveError as exc:
        db.rollback()
        raise HTTPException(422, str(exc))
    finally:
        tmp.unlink(missing_ok=True)
