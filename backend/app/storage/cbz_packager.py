import os
import asyncio
import zipfile
from typing import List, Optional
import httpx

from app.providers.base import ComicPage
# Generic image/PDF helpers live in comix.library.imaging; re-exported for older imports.
from comix.library.imaging import (  # noqa: F401
    IMAGE_EXTENSIONS, generate_comic_info_xml, detect_image_extension, natural_sort_key,
    cbz_to_pdf, pdf_ready_image as _pdf_ready_image,
)

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}

async def _download_page(client: httpx.AsyncClient, page: ComicPage, retries: int) -> Optional[bytes]:
    """Page bytes, None when the page doesn't exist (end of chapter); raises after repeated transient errors."""
    for attempt in range(retries + 1):
        try:
            resp = await client.get(page.image_url, headers=page.headers)
        except httpx.TransportError:
            if attempt == retries:
                raise
        else:
            if resp.status_code == 200:
                return resp.content
            if resp.status_code not in RETRYABLE_STATUS:
                return None
            if attempt == retries:
                resp.raise_for_status()
        await asyncio.sleep(0.5 * 2 ** attempt)
    return None

async def stream_and_package_cbz(
    pages: List[ComicPage],
    output_cbz_path: str,
    series: str,
    issue_number: Optional[str] = "1",
    publisher: Optional[str] = None,
    max_pages: Optional[int] = None,
    volume: Optional[str] = None,
    year: Optional[int] = None,
    summary: Optional[str] = None,
    retries: int = 3,
    client: Optional[httpx.AsyncClient] = None,
) -> str:
    """
    Downloads pages from provider CDN and packages them directly into a standard .cbz archive
    including ComicInfo.xml. Stops at the first missing page (end of chapter); transient
    errors are retried, and an error that persists aborts instead of producing a truncated file.
    """
    os.makedirs(os.path.dirname(os.path.abspath(output_cbz_path)), exist_ok=True)
    target_pages = pages[:max_pages] if max_pages else pages

    downloaded_images = []
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=20.0)
    try:
        for idx, page in enumerate(target_pages, start=1):
            data = await _download_page(client, page, retries)
            if data is None:
                break
            downloaded_images.append((f"page_{idx:03d}.{detect_image_extension(data)}", data))
    finally:
        if own_client:
            await client.aclose()

    if not downloaded_images:
        raise ValueError("No pages could be downloaded.")

    with zipfile.ZipFile(output_cbz_path, "w", zipfile.ZIP_DEFLATED) as cbz:
        for fname, data in downloaded_images:
            cbz.writestr(fname, data)
        xml_bytes = generate_comic_info_xml(
            series=series,
            number=issue_number,
            volume=volume,
            year=year,
            publisher=publisher,
            summary=summary,
            page_count=len(downloaded_images)
        )
        cbz.writestr("ComicInfo.xml", xml_bytes)

    return output_cbz_path
