import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from gateway import app as gateway


@pytest.fixture
def client():
    with TestClient(gateway.app) as client:
        yield client


def test_health_never_returns_credentials(client, monkeypatch):
    monkeypatch.setenv("METRON_API_TOKEN", "private-token")
    response = client.get("/api/status")
    assert response.json()["metadata"]["metron"] is True
    assert "private-token" not in response.text


@pytest.mark.parametrize("url", ["https://evil.test/x", "http://img.batcave.biz/img/x", "https://img.batcave.biz:8443/img/x", "https://user:pass@img.batcave.biz/img/x"])
def test_image_proxy_rejects_untrusted_addresses(client, url):
    assert client.get("/api/online/read/page", params={"url": url}).status_code == 422


def test_auto_returns_working_source_when_another_is_blocked(client, monkeypatch):
    async def blocked(*args):
        raise HTTPException(502, "Verification required")
    async def working(*args):
        return {"source": "getcomics", "entries": [{"title": "Available book"}]}
    monkeypatch.setattr(gateway, "batcave", blocked)
    monkeypatch.setattr(gateway, "getcomics", working)
    response = client.get("/api/online/catalog?source=auto")
    assert response.status_code == 200
    assert response.json()["source"] == "getcomics"


def test_metadata_uses_server_key_and_does_not_accept_destination_override(client, monkeypatch):
    monkeypatch.setenv("COMICVINE_API_KEY", "server-key")
    async def upstream(url, **kwargs):
        assert url == "https://comicvine.gamespot.com/api/search/"
        assert kwargs["params"]["api_key"] == "server-key"
        assert "url" not in kwargs["params"]
        return json.dumps({"results": []}).encode(), {}
    monkeypatch.setattr(gateway, "upstream", upstream)
    response = client.get("/api/upstream/comicvine/search/?query=Batman&api_key=attacker&url=http://localhost")
    assert response.status_code == 200
    assert "server-key" not in response.text
    assert client.get("/api/upstream/unknown/search/").status_code == 422


def test_getcomics_preserves_reader_and_supported_download(client, monkeypatch):
    async def upstream(url, **kwargs):
        return json.dumps([{"title": {"rendered": "Example &amp; Friends"}, "content": {"rendered": '<a href="https://readcomicsonline.ru/comic/example-2024/1">READ ONLINE</a><a href="http://getcomics.org/dls/example">DOWNLOAD NOW</a>'}}]).encode(), {}
    monkeypatch.setattr(gateway, "upstream", upstream)
    row = client.get("/api/online/catalog?source=getcomics").json()["entries"][0]
    assert row["title"] == "Example & Friends"
    assert row["reader_url"].endswith("/1")
    assert row["acquisitions"][0]["href"] == "https://getcomics.org/dls/example"


def test_metadata_allows_nested_reading_list_items(client, monkeypatch):
    monkeypatch.setenv("METRON_API_TOKEN", "server-token")
    async def upstream(url, **kwargs):
        assert url == "https://metron.cloud/api/reading_list/42/items/"
        assert kwargs["headers"]["Authorization"] == "Bearer server-token"
        return b'{"results": []}', {}
    monkeypatch.setattr(gateway, "upstream", upstream)
    assert client.get("/api/upstream/metron/reading_list/42/items/").status_code == 200
