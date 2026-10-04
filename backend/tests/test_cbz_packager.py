import asyncio
import io
import re
import zipfile
import httpx
import pytest
from PIL import Image
from app.providers.base import ComicPage
from app.storage.cbz_packager import stream_and_package_cbz, cbz_to_pdf, natural_sort_key


def image_bytes(fmt, mode="RGB", color=(200, 30, 30)):
    buf = io.BytesIO()
    Image.new(mode, (40, 60), color).save(buf, fmt)
    return buf.getvalue()


def run_package(tmp_path, handler, n_pages=5, **kwargs):
    pages = [ComicPage(page_number=i, image_url=f"https://cdn/{i}") for i in range(1, n_pages + 1)]
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    out = tmp_path / "issue.cbz"
    asyncio.run(stream_and_package_cbz(pages, str(out), series="Saga", issue_number="1",
                                       volume="2", year=2024, summary="A story", client=client, **kwargs))
    return out


def test_stops_at_end_of_chapter_and_names_by_real_type(tmp_path):
    webp = image_bytes("WEBP")

    def handler(request):
        n = int(request.url.path.strip("/"))
        return httpx.Response(200, content=webp) if n <= 3 else httpx.Response(404)

    with zipfile.ZipFile(run_package(tmp_path, handler)) as z:
        assert sorted(z.namelist()) == ["ComicInfo.xml", "page_001.webp", "page_002.webp", "page_003.webp"]
        info = z.read("ComicInfo.xml").decode()
        for tag in ("<Volume>2</Volume>", "<Year>2024</Year>", "<Summary>A story</Summary>", "<PageCount>3</PageCount>"):
            assert tag in info


def test_retries_transient_errors_instead_of_truncating(tmp_path):
    attempts = {}
    jpg = image_bytes("JPEG")

    def handler(request):
        attempts[request.url.path] = attempts.get(request.url.path, 0) + 1
        if request.url.path == "/2" and attempts["/2"] == 1:
            return httpx.Response(503)
        return httpx.Response(200, content=jpg)

    with zipfile.ZipFile(run_package(tmp_path, handler, n_pages=3)) as z:
        assert len([n for n in z.namelist() if n.startswith("page_")]) == 3


def test_persistent_error_raises_instead_of_silent_truncation(tmp_path):
    def handler(request):
        return httpx.Response(503) if request.url.path == "/2" else httpx.Response(200, content=image_bytes("JPEG"))

    with pytest.raises(httpx.HTTPStatusError):
        run_package(tmp_path, handler, n_pages=3, retries=1)


def test_cbz_to_pdf_keeps_jpeg_bytes_and_natural_page_order(tmp_path):
    jpg = image_bytes("JPEG")
    cbz = tmp_path / "user.cbz"
    with zipfile.ZipFile(cbz, "w") as z:
        z.writestr("page10.jpg", jpg)
        z.writestr("page2.png", image_bytes("PNG", "RGBA", (0, 0, 0, 0)))
        z.writestr("page1.webp", image_bytes("WEBP"))
        z.writestr("__MACOSX/._page1.webp", b"junk")
        z.writestr("ComicInfo.xml", b"<ComicInfo/>")

    pdf = cbz_to_pdf(str(cbz), str(tmp_path / "out.pdf"))
    data = open(pdf, "rb").read()
    assert len(re.findall(rb"/Type\s*/Page(?!s)", data)) == 3
    assert jpg in data  # JPEG embedded without re-encoding (lossless)


def test_natural_sort():
    names = ["page10.jpg", "page2.png", "Page1.webp"]
    assert sorted(names, key=natural_sort_key) == ["Page1.webp", "page2.png", "page10.jpg"]
