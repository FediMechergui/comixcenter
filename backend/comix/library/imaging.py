"""Image and archive helpers shared by the library, the reader and PDF export."""
import io
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Iterable, List, Optional

import img2pdf
from PIL import Image

IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif')

IMAGE_MIME_TYPES = {
    "jpg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif",
    "bmp": "image/bmp", "tif": "image/tiff", "avif": "image/avif",
}


def generate_comic_info_xml(
    series: str,
    number: Optional[str] = "1",
    volume: Optional[str] = None,
    year: Optional[int] = None,
    publisher: Optional[str] = None,
    summary: Optional[str] = None,
    page_count: int = 0
) -> bytes:
    """Generates standard ComicInfo.xml schema adhering to ComicRack / Anansi spec."""
    root = ET.Element("ComicInfo")

    ET.SubElement(root, "Series").text = series
    if number:
        ET.SubElement(root, "Number").text = str(number)
    if volume:
        ET.SubElement(root, "Volume").text = str(volume)
    if year:
        ET.SubElement(root, "Year").text = str(year)
    if publisher:
        ET.SubElement(root, "Publisher").text = publisher
    if summary:
        ET.SubElement(root, "Summary").text = summary
    if page_count:
        ET.SubElement(root, "PageCount").text = str(page_count)

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def detect_image_extension(data: bytes) -> str:
    """File extension from the image's magic bytes, independent of the file name."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:2] == b"BM":
        return "bmp"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tif"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "avif"
    return "jpg"


def natural_sort_key(name: str):
    """"page2" sorts before "page10"."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r'(\d+)', name)]


def is_page_image(name: str) -> bool:
    """Image entries inside an archive, skipping macOS resource forks and hidden files."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    return (name.lower().endswith(IMAGE_EXTENSIONS)
            and not name.startswith("__MACOSX/") and not base.startswith("."))


def pdf_ready_image(data: bytes) -> bytes:
    """
    JPEG and alpha-free PNG pass through untouched (img2pdf embeds them losslessly);
    anything else (WEBP, GIF, transparent PNG, ...) is converted to a lossless PNG.
    """
    with Image.open(io.BytesIO(data)) as img:
        if img.format == "JPEG" or (img.format == "PNG" and img.mode in ("L", "RGB", "P", "1")
                                    and "transparency" not in img.info):
            return data
        # Flatten transparency onto white, not the black that convert("RGB") would give
        rgba = img.convert("RGBA")
        flat = Image.new("RGB", rgba.size, "white")
        flat.paste(rgba, mask=rgba.getchannel("A"))
        out = io.BytesIO()
        flat.save(out, "PNG")
        return out.getvalue()


def images_to_pdf(images: Iterable[bytes]) -> bytes:
    """One PDF page per image at its original size; JPEG pages are embedded without re-encoding."""
    prepared: List[bytes] = [pdf_ready_image(data) for data in images]
    if not prepared:
        raise ValueError("No images to convert.")
    return img2pdf.convert(prepared)


def cbz_to_pdf(cbz_path: str, output_pdf_path: str) -> str:
    """Converts a CBZ archive into a PDF with img2pdf (lossless for JPEG pages)."""
    os.makedirs(os.path.dirname(os.path.abspath(output_pdf_path)), exist_ok=True)

    with zipfile.ZipFile(cbz_path, 'r') as cbz:
        image_files = sorted((f for f in cbz.namelist() if is_page_image(f)), key=natural_sort_key)
        if not image_files:
            raise ValueError("No images found in CBZ archive.")
        pdf = images_to_pdf(cbz.read(name) for name in image_files)

    with open(output_pdf_path, "wb") as f:
        f.write(pdf)

    return output_pdf_path
