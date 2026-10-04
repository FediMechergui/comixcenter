import re

import pytest
from fastapi.testclient import TestClient

from comix.api.app import create_app
from comix.ingest import jobs
from tests.comix_app import samples


@pytest.fixture
def client(database, metron, comicvine):
    with TestClient(create_app(run_migrations=False, start_worker=False)) as c:
        yield c


def sync(client, kind, metron_id, **extra):
    r = client.post("/api/admin/sync", json={"kind": kind, "metron_id": metron_id, **extra})
    assert r.status_code == 200, r.text
    jobs.run_pending()
    return r.json()


@pytest.fixture
def loaded(client):
    for sid in (10, 20, 22, 30):
        sync(client, "series", sid)
    sync(client, "arc", 300)
    sync(client, "arc", 301)
    sync(client, "team", 201)
    status = client.get("/api/admin/jobs?status=failed").json()
    assert status["counts"]["failed"] == 0, status["jobs"]
    return client


def test_status_reports_sources_and_counts(loaded):
    s = loaded.get("/api/status").json()
    assert s["sources"] == {"metron": False, "comicvine": False}   # fakes injected, no real keys
    assert s["counts"]["series"] >= 4 and s["counts"]["arcs"] == 2


def test_browse_publisher_universe_era_series_issue(loaded):
    c = loaded
    marvel = next(p for p in c.get("/api/publishers").json() if p["slug"] == "marvel")
    pub = c.get(f"/api/publishers/{marvel['id']}").json()
    e616 = next(u for u in pub["universes"] if u["slug"] == "earth-616")
    assert e616["series_count"] >= 3
    uni = c.get(f"/api/universes/{e616['id']}").json()
    fresh = next(e for e in uni["eras"] if e["name"] == "Fresh Start")
    assert fresh["series_count"] >= 2            # House of X (2019), Inferno (2021)
    series = c.get(f"/api/series?era_id={fresh['id']}").json()["items"]
    assert {"House of X", "Inferno"} <= {s["name"] for s in series}
    silver = next(e for e in uni["eras"] if e["name"] == "Silver Age")
    asm = c.get(f"/api/series?era_id={silver['id']}").json()["items"]
    assert [s["name"] for s in asm] == ["Amazing Spider-Man"]     # 1963-1988 overlaps Silver Age

    hox = next(s for s in series if s["name"] == "House of X")
    detail = c.get(f"/api/series/{hox['id']}").json()
    assert [i["number"] for i in detail["issues"]] == ["1", "2"]
    assert detail["writers"][0]["name"] == "Jonathan Hickman"
    issue = c.get(f"/api/issues/{detail['issues'][0]['id']}").json()
    assert issue["description"] == "Welcome to Krakoa." and issue["arcs"][0]["name"] == "House of X / Powers of X"
    assert {ch["name"] for ch in issue["characters"]} == {"Cyclops", "Jean Grey"}
    assert issue["collected_in"][0]["series_name"] == "House of X / Powers of X"
    assert [l["service"] for l in issue["legal_links"]][0] == "Marvel Unlimited"
    assert issue["next_issue_id"] == detail["issues"][1]["id"]


def test_search(loaded):
    hits = loaded.get("/api/search", params={"q": "hous x"}).json()["results"]
    assert hits[0]["kind"] in ("series", "arc") and "House of X" in hits[0]["title"]
    chars = loaded.get("/api/search", params={"q": "jean", "kinds": "character"}).json()["results"]
    assert chars[0]["title"] == "Jean Grey"
    issues = loaded.get("/api/issues", params={"q": "inferno 1"}).json()
    assert issues[0]["series_name"] == "Inferno"


def test_prerequisite_plan_and_cycle_guard(loaded):
    c = loaded
    arcs = {a["name"]: a for a in c.get("/api/arcs").json()["items"]}
    hox, inferno = arcs["House of X / Powers of X"], arcs["Inferno"]
    r = c.post(f"/api/admin/arcs/{inferno['id']}/links", json={"target_arc_id": hox["id"], "kind": "prerequisite",
                                                                "note": "Moira's secrets"})
    assert r.status_code == 200
    cycle = c.post(f"/api/admin/arcs/{hox['id']}/links", json={"target_arc_id": inferno["id"], "kind": "prerequisite"})
    assert cycle.status_code == 409
    plan = c.get(f"/api/arcs/{inferno['id']}/plan").json()
    assert [s["name"] for s in plan["sequence"]] == ["House of X / Powers of X"]
    assert plan["remaining_issues"] == 2 and plan["edges"][0]["note"] == "Moira's secrets"
    detail = c.get(f"/api/arcs/{inferno['id']}").json()
    assert detail["prerequisites"][0]["name"] == "House of X / Powers of X"
    hox_detail = c.get(f"/api/arcs/{hox['id']}").json()
    assert hox_detail["required_by"][0]["name"] == "Inferno"
    assert hox_detail["collected_editions"][0]["covers"] == 2
    assert hox_detail["creators"][0]["role"] == "Writer"


def test_tiered_order_paths_and_shared_progress(loaded):
    c = loaded
    arcs = {a["name"]: a for a in c.get("/api/arcs").json()["items"]}
    order = c.post("/api/admin/orders", json={"name": "Krakoa", "kind": "custom"}).json()
    e1 = c.post(f"/api/admin/orders/{order['id']}/entries", json={"arc_id": arcs["House of X / Powers of X"]["id"], "tier": "essential"}).json()
    e2 = c.post(f"/api/admin/orders/{order['id']}/entries", json={"arc_id": arcs["Inferno"]["id"], "tier": "optional"}).json()
    issue_id = c.get("/api/issues", params={"q": "inferno 1"}).json()[0]["id"]
    e0 = c.post(f"/api/admin/orders/{order['id']}/entries", json={"issue_id": issue_id, "tier": "skip", "position": 0}).json()
    assert e0["position"] == 0

    core = c.get(f"/api/orders/{order['id']}?path=core").json()
    assert [e["type"] for e in core["entries"]] == ["arc"]
    complete = c.get(f"/api/orders/{order['id']}?path=complete").json()
    assert len(complete["entries"]) == 2
    everything = c.get(f"/api/orders/{order['id']}?path=all").json()
    assert [e["id"] for e in everything["entries"]] == [e0["id"], e1["id"], e2["id"]]

    # Reading Inferno #1 directly shows up inside the Inferno arc entry of this order
    c.put(f"/api/issues/{issue_id}/read", json={"read": True})
    complete = c.get(f"/api/orders/{order['id']}?path=complete").json()
    inferno_entry = next(e for e in complete["entries"] if e["type"] == "arc" and e["arc"]["name"] == "Inferno")
    assert inferno_entry["done"] and complete["next_entry_id"] == e1["id"]

    assert c.post(f"/api/orders/{order['id']}/read-through", json={"entry_id": e1["id"], "path": "core"}).json()["marked"] == 2
    prog = c.get(f"/api/orders/{order['id']}").json()["progress"]["paths"]
    assert prog["core"] == {"issues": 2, "read": 2} and prog["complete"]["read"] == 3

    c.patch(f"/api/admin/entries/{e2['id']}", json={"position": 0, "tier": "recommended", "note": "Optional epilogue"})
    reordered = c.get(f"/api/orders/{order['id']}?path=all").json()["entries"]
    assert reordered[0]["id"] == e2["id"] and reordered[0]["note"] == "Optional epilogue"


def test_generated_orders(loaded):
    c = loaded
    arcs = {a["name"]: a for a in c.get("/api/arcs").json()["items"]}
    event = c.post("/api/admin/orders/generate", json={"source": "event", "id": arcs["House of X / Powers of X"]["id"]}).json()
    assert event["source"] == "generated" and event["progress"]["entries"] == 2
    unis = c.get(f"/api/publishers/{c.get('/api/publishers').json()[0]['id']}").json()["universes"]
    e616 = next(u for u in unis if u["slug"] == "earth-616")
    master = c.post("/api/admin/orders/generate", json={"source": "universe", "id": e616["id"]}).json()
    detail = c.get(f"/api/orders/{master['id']}?path=all").json()
    assert [e["arc"]["name"] for e in detail["entries"]] == ["House of X / Powers of X", "Inferno"]
    # Regenerating replaces the draft in place
    again = c.post("/api/admin/orders/generate", json={"source": "universe", "id": e616["id"]}).json()
    assert again["id"] == master["id"]
    xmen = next(t for t in c.get("/api/teams").json()["items"] if t["name"] == "X-Men")
    team_order = c.post("/api/admin/orders/generate", json={"source": "team", "id": xmen["id"]}).json()
    assert team_order["progress"]["entries"] == 2
    hickman = c.get("/api/search", params={"q": "hickman", "kinds": "creator"}).json()["results"][0]
    run = c.post("/api/admin/orders/generate", json={"source": "writer", "id": hickman["id"]}).json()
    assert run["progress"]["entries"] == 3


def test_characters_and_teams(loaded):
    c = loaded
    cyclops = next(ch for ch in c.get("/api/characters").json()["items"] if ch["name"] == "Cyclops")
    detail = c.get(f"/api/characters/{cyclops['id']}").json()
    ident = detail["identities"][0]
    assert ident["real_name"] == "Scott Summers" and detail["teams"][0]["name"] == "X-Men"
    apps = c.get(f"/api/characters/{cyclops['id']}/appearances").json()
    assert apps["total"] == 3
    unis = c.get(f"/api/publishers/{c.get('/api/publishers').json()[0]['id']}").json()["universes"]
    e616 = next(u for u in unis if u["slug"] == "earth-616")
    fresh = next(e for e in c.get(f"/api/universes/{e616['id']}").json()["eras"] if e["name"] == "Fresh Start")
    assert c.get(f"/api/characters/{cyclops['id']}/appearances?era_id={fresh['id']}").json()["total"] == 3
    assert c.get(f"/api/characters/{cyclops['id']}/appearances?role=main").json()["total"] == 0
    graph = c.get(f"/api/characters/{cyclops['id']}/graph").json()
    assert graph["links"][0]["name"] == "Jean Grey"

    xmen = next(t for t in c.get("/api/teams").json()["items"] if t["name"] == "X-Men")
    team = c.get(f"/api/teams/{xmen['id']}").json()
    assert {r["display_name"] for r in team["roster"]} == {"Scott Summers", "Jean Grey"}
    assert team["appearances"] == 3

    # Curation: regroup an identity under a new mantle, mark a death
    phoenix = c.post("/api/admin/characters", json={"name": "Phoenix"}).json()
    jean = next(ch for ch in c.get("/api/characters").json()["items"] if ch["name"] == "Jean Grey")
    jean_ident = c.get(f"/api/characters/{jean['id']}").json()["identities"][0]
    c.patch(f"/api/admin/identities/{jean_ident['id']}", json={"character_id": phoenix["id"]})
    assert c.get(f"/api/characters/{jean['id']}").status_code == 404        # empty mantle removed
    c.post("/api/admin/character-events", json={"identity_id": jean_ident["id"], "kind": "resurrection",
                                                "issue_text": "Fantastic Four #286", "note": "Returns"})
    events = c.get(f"/api/characters/{phoenix['id']}").json()["identities"][0]["events"]
    assert any(e["kind"] == "resurrection" for e in events)


def test_library_reader_flow(loaded, tmp_path):
    c = loaded
    hox1 = c.get("/api/issues", params={"q": "house of x 1"}).json()
    hox1 = next(i for i in hox1 if i["series_name"] == "House of X" and i["number"] == "1")
    cbz = samples.make_cbz(tmp_path / "upload.cbz", 3, samples.comicinfo_xml("House of X", "1", 2019))
    with open(cbz, "rb") as f:
        r = c.post("/api/library/upload", files=[("files", ("House of X 001 (2019).cbz", f, "application/zip"))])
    res = r.json()["results"][0]
    assert res["ok"] and res["file"]["issue"]["id"] == hox1["id"]
    fid = res["file"]["id"]

    img = c.get(f"/api/library/{fid}/pages/0")
    assert img.status_code == 200 and img.headers["content-type"] == "image/jpeg"
    small = c.get(f"/api/library/{fid}/pages/0?w=300")
    assert small.status_code == 200 and small.content != img.content
    assert c.get(f"/api/library/{fid}/pages/0", headers={"If-None-Match": img.headers["etag"]}).status_code == 304
    assert c.get(f"/api/library/{fid}/pages/9").status_code == 404
    panels = c.get(f"/api/library/{fid}/pages/1/panels").json()
    assert panels["panels"] == [[0.0, 0.0, 1.0, 1.0]]

    assert c.put(f"/api/library/{fid}/position", json={"page": 2}).json()["finished"] is True
    assert c.get(f"/api/issues/{hox1['id']}").json()["read"] is True
    pdf = c.get(f"/api/library/{fid}/export.pdf")
    assert pdf.content.startswith(b"%PDF") and "attachment" in pdf.headers["content-disposition"]

    # Unmatched upload, then manual match
    with open(samples.make_cbz(tmp_path / "x.cbz", 1), "rb") as f:
        r = c.post("/api/library/upload", files=[("files", ("mystery.cbz", f, "application/zip"))]).json()["results"][0]
    assert r["file"]["issue"] is None
    lib = c.get("/api/library?status=unmatched").json()
    assert lib["counts"]["unmatched"] == 1
    fixed = c.patch(f"/api/library/{r['file']['id']}", json={"issue_id": hox1["id"]}).json()
    assert fixed["match_method"] == "manual"
    bad = c.post("/api/library/upload", files=[("files", ("bad.cbz", b"not a comic", "application/zip"))]).json()
    assert bad["results"][0]["ok"] is False


def test_admin_token_protects_curation(database, metron, comicvine, monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", "s3cret")
    from comix import config
    config.get_settings.cache_clear()
    with TestClient(create_app(run_migrations=False, start_worker=False)) as c:
        assert c.post("/api/admin/orders", json={"name": "x"}).status_code == 401
        assert c.post("/api/admin/orders", json={"name": "x"}, headers={"X-Admin-Token": "nope"}).status_code == 401
        assert c.post("/api/admin/orders", json={"name": "x"}, headers={"X-Admin-Token": "s3cret"}).status_code == 200
        assert c.get("/api/orders").status_code == 200          # reading stays open
