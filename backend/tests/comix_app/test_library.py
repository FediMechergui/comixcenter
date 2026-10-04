import re
from datetime import date

import httpx
import pytest
from sqlalchemy import select

from comix.library import opds
from comix.library.archives import _rar_tool, detect_format, open_archive
from comix.library.comicinfo import extract_ids_from_notes, parse_metroninfo
from comix.library.importer import export_pdf, import_file, record_position, scan_directories
from comix.library.matching import guess_from_filename, rematch_unmatched
from comix.library.panels import detect_panels
from comix.models import Issue, LibraryFile, ReadStatus, Series
from tests.comix_app import samples


@pytest.fixture
def catalog(session):
    saga = Series(name="Saga", year_began=2012, first_cover_date=date(2012, 3, 1), last_cover_date=date(2018, 7, 1))
    asm = Series(name="Amazing Spider-Man", year_began=1963, first_cover_date=date(1963, 3, 1),
                 last_cover_date=date(1998, 11, 1))
    asm18 = Series(name="Amazing Spider-Man", year_began=2018, first_cover_date=date(2018, 7, 1),
                   last_cover_date=date(2022, 3, 1))
    session.add_all([saga, asm, asm18]); session.flush()
    issues = {
        "saga1": Issue(series_id=saga.id, number="1", number_sort=1, cover_date=date(2012, 3, 1)),
        "saga54": Issue(series_id=saga.id, number="54", number_sort=54, cover_date=date(2018, 7, 1), upc="70985302864105411"),
        "asm300": Issue(series_id=asm.id, number="300", number_sort=300, cover_date=date(1988, 5, 1), cv_id=7000),
        "asm18_1": Issue(series_id=asm18.id, number="1", number_sort=1, cover_date=date(2018, 9, 1)),
        "asm63_1": Issue(series_id=asm.id, number="1", number_sort=1, cover_date=date(1963, 3, 1)),
    }
    session.add_all(issues.values()); session.flush()
    return issues


def test_filename_guesses():
    assert guess_from_filename("Saga 054 (2018) (Digital) (Zone-Empire).cbz") == \
        {"series": "Saga", "number": "54", "year": 2018, "volume": None}
    g = guess_from_filename("Amazing_Spider-Man_v5_001_(2018).cbr")
    assert (g["series"], g["number"], g["year"], g["volume"]) == ("Amazing Spider-Man", "1", 2018, "5")
    assert guess_from_filename("Saga #3.cbz")["number"] == "3"


def test_ids_from_tagger_notes_and_metroninfo():
    assert extract_ids_from_notes("Tagged with ComicTagger using info from Comic Vine [Issue ID 6686]", None) == {"comicvine": 6686}
    assert extract_ids_from_notes("Tagged with MetronTagger using info from Metron [Issue ID 55]", None) == {"metron": 55}
    xml = (b'<MetronInfo><IDS><ID source="Metron" primary="true">123</ID><ID source="Comic Vine">456</ID></IDS>'
           b'<Series><Name>Saga</Name><StartYear>2012</StartYear></Series><Number>54</Number>'
           b'<CoverDate>2018-07-01</CoverDate></MetronInfo>')
    info = parse_metroninfo(xml)
    assert info["ids"] == {"metron": 123, "comicvine": 456} and info["Year"] == "2018" and info["Series"] == "Saga"


def test_formats_open_with_pages_in_order(tmp_path):
    cbz = samples.make_cbz(tmp_path / "a.cbz", 3, names=["p10.jpg", "p2.jpg", "p1.jpg"])
    cb7 = samples.make_cb7(tmp_path / "b.cb7", 2)
    epub = samples.make_epub(tmp_path / "c.epub", 3)
    pdf = samples.make_pdf(tmp_path / "d.pdf", 2)
    renamed = tmp_path / "zip-but-called.cbr"
    renamed.write_bytes(cbz.read_bytes())
    assert [detect_format(p) for p in (cbz, cb7, epub, pdf, renamed)] == ["cbz", "cb7", "epub", "pdf", "cbz"]

    z = open_archive(cbz, "cbz", tmp_path / "cache-a")
    assert z.names == ["p1.jpg", "p2.jpg", "p10.jpg"] and z.page(0)[1] == "image/jpeg"
    e = open_archive(epub, "epub", tmp_path / "cache-c")
    assert e.names == ["OEBPS/images/img3.jpg", "OEBPS/images/img2.jpg", "OEBPS/images/img1.jpg"]  # spine order
    s = open_archive(cb7, "cb7", tmp_path / "cache-b")
    assert s.page_count == 2 and s.page(1)[0][:3] == b"\xff\xd8\xff"
    p = open_archive(pdf, "pdf", tmp_path / "cache-d")
    data, mime = p.page(1)
    assert p.page_count == 2 and mime == "image/jpeg" and (tmp_path / "cache-d" / "rendered" / "00001.jpg").exists()
    p.close()


def test_rar_tool_available_on_this_machine():
    # Windows 10+ ships bsdtar as tar.exe, which reads RAR4/RAR5
    assert _rar_tool() is not None


def test_import_matches_by_comicinfo_and_dedupes(session, catalog, tmp_path):
    src = samples.make_cbz(tmp_path / "whatever.cbz", 2, samples.comicinfo_xml("Saga", "1", 2012))
    lf, created = import_file(session, src)
    assert created and lf.issue_id == catalog["saga1"].id and lf.match_method == "comicinfo"
    assert lf.page_count == 2 and lf.managed and lf.path != str(src)
    again, created_again = import_file(session, src)
    assert not created_again and again.id == lf.id


def test_import_matches_by_embedded_id_and_by_filename(session, catalog, tmp_path):
    tagged = samples.make_cbz(tmp_path / "x.cbz", 1, samples.comicinfo_xml(
        "Wrong Name", "9", notes="Tagged with ComicTagger using info from Comic Vine [Issue ID 7000]"))
    lf, _ = import_file(session, tagged)
    assert lf.issue_id == catalog["asm300"].id and lf.match_method == "embedded-id"

    named = samples.make_cbz(tmp_path / "Saga 054 (2018) (Digital) (Zone-Empire).cbz", 2)
    lf2, _ = import_file(session, named)
    assert lf2.issue_id == catalog["saga54"].id and lf2.match_method == "filename"


def test_year_picks_the_right_volume_and_ambiguity_is_left_to_the_user(session, catalog, tmp_path):
    lf, _ = import_file(session, samples.make_cbz(tmp_path / "Amazing Spider-Man 001 (2018).cbz", 1))
    assert lf.issue_id == catalog["asm18_1"].id
    lf2, _ = import_file(session, samples.make_cbz(tmp_path / "Amazing Spider-Man 001.cbz", 2))
    assert lf2.issue_id is None                         # two #1s, no year: ask the user
    assert {c["issue_id"] for c in lf2.parsed["candidates"]} == {catalog["asm18_1"].id, catalog["asm63_1"].id}


def test_unmatched_file_matches_after_catalog_grows(session, catalog, tmp_path):
    lf, _ = import_file(session, samples.make_cbz(tmp_path / "Inferno 001 (2021).cbz", 1))
    assert lf.issue_id is None
    series = Series(name="Inferno", year_began=2021, first_cover_date=date(2021, 11, 1))
    session.add(series); session.flush()
    session.add(Issue(series_id=series.id, number="1", number_sort=1, cover_date=date(2021, 11, 1))); session.flush()
    assert rematch_unmatched(session) == {"checked": 1, "matched": 1}


def test_reading_position_marks_issue_read_and_pdf_export(session, catalog, tmp_path):
    lf, _ = import_file(session, samples.make_cbz(tmp_path / "s.cbz", 3, samples.comicinfo_xml("Saga", "1", 2012)))
    assert record_position(session, lf, 1) is False
    assert session.get(ReadStatus, (1, catalog["saga1"].id)) is None
    assert record_position(session, lf, 2) is True
    assert session.get(ReadStatus, (1, catalog["saga1"].id)) is not None
    pdf = export_pdf(lf)
    assert pdf.startswith(b"%PDF") and len(re.findall(rb"/Type\s*/Page(?!s)", pdf)) == 3


def test_scan_directories_references_files_in_place(session, catalog, tmp_path):
    folder = tmp_path / "comics"; (folder / "sub").mkdir(parents=True)
    samples.make_cbz(folder / "Saga 001 (2012).cbz", 1)
    samples.make_epub(folder / "sub" / "book.epub", 2)
    (folder / "notes.txt").write_text("ignore me")
    (folder / "broken.cbz").write_bytes(b"PK\x03\x04garbage")
    out = scan_directories(session, [folder])
    assert out["seen"] == 3 and out["added"] == 2 and len(out["errors"]) == 1
    files = session.scalars(select(LibraryFile)).all()
    assert all(not f.managed for f in files)
    assert scan_directories(session, [folder])["added"] == 0      # idempotent


def test_panel_detection_finds_grid_in_reading_order():
    width, height, panels = detect_panels(samples.grid_page())
    assert (width, height) == (800, 1200) and len(panels) == 5
    xs = [round(p[0], 2) for p in panels]
    ys = [round(p[1], 2) for p in panels]
    assert xs[:4] == [0.05, 0.52, 0.05, 0.52] and ys[0] == ys[1] < ys[2] == ys[3] < ys[4]
    assert panels[4][2] > 0.85                           # the wide bottom panel
    _, _, rtl = detect_panels(samples.grid_page(), rtl=True)
    assert [round(p[0], 2) for p in rtl[:2]] == [0.52, 0.05]
    _, _, single = detect_panels(samples.page_image())    # full-bleed page: one panel
    assert len(single) == 1


OPDS_FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <title>My Komga</title>
  <link rel="next" href="/opds/v1.2/series?page=2" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <entry>
    <title>Saga</title>
    <link rel="subsection" href="/opds/v1.2/series/1" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>
  <entry>
    <title>Saga #1</title><summary>Issue one</summary>
    <link rel="http://opds-spec.org/image/thumbnail" href="/thumb/1.jpg" type="image/jpeg"/>
    <link rel="http://opds-spec.org/acquisition" href="/opds/v1.2/books/1/file" type="application/vnd.comicbook+zip"/>
    <link rel="http://opds-spec.org/acquisition/buy" href="https://shop/1" type="text/html"/>
  </entry>
</feed>"""


def test_opds_parse_and_download(monkeypatch, tmp_path):
    feed = opds.parse_feed(OPDS_FEED, "https://komga.local/opds/v1.2/catalog")
    nav, pub = feed["entries"]
    assert nav["kind"] == "navigation" and nav["href"] == "https://komga.local/opds/v1.2/series/1"
    assert pub["kind"] == "publication" and len(pub["acquisitions"]) == 1          # buy link ignored
    assert pub["acquisitions"][0]["href"] == "https://komga.local/opds/v1.2/books/1/file"
    assert pub["cover"] == "https://komga.local/thumb/1.jpg"
    assert feed["next"] == "https://komga.local/opds/v1.2/series?page=2"

    book = samples.make_cbz(tmp_path / "book.cbz", 1).read_bytes()

    def handler(request):
        assert request.headers["authorization"].startswith("Basic ")
        return httpx.Response(200, content=OPDS_FEED if request.url.path.endswith("catalog") else book)
    monkeypatch.setattr(opds, "_client", lambda u, p: httpx.Client(transport=httpx.MockTransport(handler),
                                                                    auth=(u, p) if u else None, follow_redirects=True))
    assert opds.browse("https://komga.local/opds/v1.2/catalog", "me", "pw")["title"] == "My Komga"
    path = opds.download("https://komga.local/opds/v1.2/books/1/file", "me", "pw")
    assert path.read_bytes() == book
    path.unlink()
    with pytest.raises(opds.OpdsError):
        opds.browse("file:///etc/passwd")
