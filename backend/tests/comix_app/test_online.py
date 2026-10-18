import asyncio

import pytest
from fastapi.testclient import TestClient

from comix.api.app import create_app
from comix.services.online import OnlineReader, checked_url, normalize_chapters, parse_catalog


CATALOG = """<li class="latest"><a href="/123-example.html"><img src="/uploads/mini/cover.webp"></a>
<p class="latest__title"><a href="/123-example.html">Example (2024-)</a></p>
<p class="latest__chapter"><a>18.10.2026 - Example (2024-) #10</a></p></li>"""


def test_catalog_keeps_reader_links_and_normalizes_covers():
    entries = parse_catalog(CATALOG + CATALOG)
    assert len(entries) == 1
    assert entries[0]["title"] == "Example (2024-) #10"
    assert entries[0]["reader_url"] == "https://batcave.biz/123-example.html"
    assert entries[0]["cover"] == "https://batcave.biz/uploads/mini/cover.webp"
    assert entries[0]["acquisitions"] == []


@pytest.mark.parametrize("url", ["https://batcave.biz.evil.test/123.html", "http://batcave.biz/123.html", "https://user:password@batcave.biz/123.html", "file:///etc/passwd"])
def test_reader_rejects_urls_outside_source(url):
    with pytest.raises(ValueError):
        checked_url(url)


def test_chapters_sort_by_issue_number_not_source_identifier():
    chapters = normalize_chapters({"chapters": [{"id": 5, "title": "Example #10"}, {"id": 9, "title": "Example #2"}, {"id": 10, "title": "Example #1"}]})
    assert [c["id"] for c in chapters] == ["10", "9", "5"]


def test_only_pages_from_selected_comic_are_registered(monkeypatch):
    reader = OnlineReader()
    async def document(url):
        if "/reader/" in url:
            return "", {"images": ["https://img.batcave.biz/img/page.jpg", "https://evil.test/image.jpg"]}
        return "", {"news_id": 123, "chapters": [{"id": 8, "title": "Example #1"}]}
    monkeypatch.setattr(reader, "document", document)
    result = asyncio.run(reader.pages("https://batcave.biz/123-example.html", "8"))
    assert result["pages"] == ["https://img.batcave.biz/img/page.jpg"]
    with pytest.raises(ValueError):
        asyncio.run(reader.pages("https://batcave.biz/123-example.html", "999"))
    with pytest.raises(ValueError):
        asyncio.run(reader.image("https://img.batcave.biz/img/unregistered.jpg"))


def test_library_mutations_require_configured_token(database, monkeypatch):
    from comix.config import get_settings
    monkeypatch.setenv("ADMIN_TOKEN", "private-test-token")
    get_settings.cache_clear()
    with TestClient(create_app(run_migrations=False, start_worker=False)) as client:
        assert client.delete("/api/library/1").status_code == 401
        assert client.post("/api/library/scan", json={"paths": []}).status_code == 401
        assert client.post("/api/opds", json={"name": "x", "url": "http://localhost"}).status_code == 401
        assert client.get("/api/library").status_code == 200
        assert client.delete("/api/library/1", headers={"X-Admin-Token": "private-test-token"}).status_code == 404
    get_settings.cache_clear()


def test_search_kinds_cannot_change_sql(database):
    with TestClient(create_app(run_migrations=False, start_worker=False)) as client:
        response = client.get("/api/search", params={"q": "example", "kinds": "series') OR 1=1 --"})
        assert response.status_code == 200
        assert response.json()["results"] == []
        assert len(client.get("/api/universes").json()) >= 20
