"""Builds small real comic files (CBZ, CB7, EPUB, PDF) and synthetic pages for tests."""
import io
import zipfile
from pathlib import Path
from typing import List, Optional

import img2pdf
from PIL import Image, ImageDraw


def page_image(label: int = 0, size=(400, 600), fmt: str = "JPEG", color=(220, 60, 60)) -> bytes:
    img = Image.new("RGB", size, color)
    ImageDraw.Draw(img).text((20, 20), f"page {label}", fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, fmt)
    return buf.getvalue()


def comicinfo_xml(series: str, number: str, year: Optional[int] = None, notes: Optional[str] = None) -> bytes:
    parts = [f"<Series>{series}</Series>", f"<Number>{number}</Number>"]
    if year:
        parts.append(f"<Year>{year}</Year>")
    if notes:
        parts.append(f"<Notes>{notes}</Notes>")
    return ('<?xml version="1.0"?><ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            + "".join(parts) + "</ComicInfo>").encode()


def make_cbz(path: Path, pages: int = 3, comicinfo: Optional[bytes] = None, names: Optional[List[str]] = None) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        for i in range(pages):
            z.writestr(names[i] if names else f"p{i + 1:03d}.jpg", page_image(i + 1))
        if comicinfo:
            z.writestr("ComicInfo.xml", comicinfo)
    return path


def make_cb7(path: Path, pages: int = 2) -> Path:
    import py7zr
    with py7zr.SevenZipFile(path, "w") as z:
        for i in range(pages):
            z.writestr(page_image(i + 1), f"pages/{i + 1}.jpg")
    return path


def make_epub(path: Path, pages: int = 2) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml",
                   '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        manifest, spine = [], []
        # Spine order deliberately differs from file-name order
        order = list(range(pages, 0, -1))
        for n in order:
            z.writestr(f"OEBPS/images/img{n}.jpg", page_image(n))
            z.writestr(f"OEBPS/page{n}.xhtml",
                       f'<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/img{n}.jpg"/></body></html>')
            manifest.append(f'<item id="p{n}" href="page{n}.xhtml" media-type="application/xhtml+xml"/>')
            manifest.append(f'<item id="i{n}" href="images/img{n}.jpg" media-type="image/jpeg"/>')
            spine.append(f'<itemref idref="p{n}"/>')
        z.writestr("OEBPS/content.opf",
                   '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>' + "".join(manifest)
                   + '</manifest><spine>' + "".join(spine) + "</spine></package>")
    return path


def make_pdf(path: Path, pages: int = 2) -> Path:
    path.write_bytes(img2pdf.convert([page_image(i + 1) for i in range(pages)]))
    return path


def grid_page() -> bytes:
    """White page: a 2x2 grid of framed panels above one wide panel (5 panels)."""
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    boxes = [(40, 40, 380, 400), (420, 40, 760, 400), (40, 440, 380, 800), (420, 440, 760, 800), (40, 840, 760, 1160)]
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        d.rectangle((x0, y0, x1, y1), outline="black", width=6, fill=(200 - i * 20, 220, 240))
        d.text((x0 + 20, y0 + 20), f"panel {i + 1}", fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
