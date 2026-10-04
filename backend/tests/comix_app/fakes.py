"""In-memory stand-ins for the Metron (mokkari) and Comic Vine (simyan) clients."""
from datetime import date
from types import SimpleNamespace as NS
from typing import Any, Dict, List

MARVEL = NS(id=1, name="Marvel")
DC = NS(id=2, name="DC Comics")
ONGOING = NS(id=1, name="Ongoing Series")
LIMITED = NS(id=2, name="Limited Series")
TPB = NS(id=3, name="Trade Paperback")


def _res(id_: int, name: str) -> NS:
    return NS(id=id_, name=name, modified=None)


class FakeMetron:
    def __init__(self) -> None:
        self.calls: List[str] = []
        self.series_db: Dict[int, NS] = {
            10: NS(id=10, name="Amazing Spider-Man", sort_name="Amazing Spider-Man", volume=1, year_began=1963,
                   year_end=1998, series_type=ONGOING, status="Completed", desc="Peter Parker's flagship.",
                   issue_count=3, cv_id=2127, gcd_id=None, publisher=MARVEL, imprint=None, display_name="Amazing Spider-Man (1963)"),
            20: NS(id=20, name="House of X", sort_name="House of X", volume=1, year_began=2019, year_end=2019,
                   series_type=LIMITED, status="Completed", desc="Krakoa begins.", issue_count=2, cv_id=None, gcd_id=None,
                   publisher=MARVEL, imprint=None, display_name="House of X (2019)"),
            22: NS(id=22, name="Inferno", sort_name="Inferno", volume=2, year_began=2021, year_end=2022,
                   series_type=LIMITED, status="Completed", desc="", issue_count=1, cv_id=None, gcd_id=None,
                   publisher=MARVEL, imprint=None, display_name="Inferno (2021)"),
            30: NS(id=30, name="House of X / Powers of X", sort_name="House of X / Powers of X", volume=1,
                   year_began=2019, year_end=2019, series_type=TPB, status="Completed", desc="", issue_count=1,
                   cv_id=None, gcd_id=None, publisher=MARVEL, imprint=None, display_name="House of X / Powers of X (2019)"),
            40: NS(id=40, name="Batman", sort_name="Batman", volume=3, year_began=2016, year_end=None,
                   series_type=ONGOING, status="Ongoing", desc="", issue_count=1, cv_id=None, gcd_id=None,
                   publisher=DC, imprint=None, display_name="Batman (2016)"),
        }
        s = self.series_db
        self.issues_db: Dict[int, NS] = {}

        def issue(id_, series_id, number, cover, *, chars=(), teams=(), arcs=(), universes=(), reprints=(),
                  credits=(), cv_id=None, desc=""):
            ser = s[series_id]
            self.issues_db[id_] = NS(
                id=id_, number=number, cover_date=cover, store_date=None, foc_date=None,
                image=f"https://static.metron.cloud/{id_}.jpg", cover_hash="", modified=None,
                issue_name=f"{ser.name} ({ser.year_began}) #{number}",
                series=NS(id=ser.id, name=ser.name, sort_name=ser.sort_name, alt_names=[], volume=ser.volume,
                          year_began=ser.year_began, series_type=ser.series_type, genres=[], language="en"),
                publisher=ser.publisher, imprint=None, alt_number="", collection_title="",
                story_titles=[f"Story {number}"], price=None, price_currency="", rating=None, sku="", isbn="",
                upc="", page_count=32, desc=desc, arcs=[_res(*a) for a in arcs],
                credits=[NS(id=cid, creator=cname, role=[NS(id=1, name=r) for r in roles]) for cid, cname, roles in credits],
                characters=[_res(*c) for c in chars], teams=[_res(*t) for t in teams],
                universes=[_res(*u) for u in universes], reprints=[NS(id=rid, issue=txt) for rid, txt in reprints],
                variants=[], average_rating=None, rating_count=0, cv_id=cv_id, gcd_id=None, resource_url=None)

        spidey, miles, mj = (100, "Spider-Man"), (101, "Spider-Man (Miles Morales)"), (102, "Mary Jane Watson")
        cyclops, jean = (110, "Cyclops"), (111, "Jean Grey")
        avengers, xmen = (200, "Avengers"), (201, "X-Men")
        hoxpox, inferno = (300, "House of X / Powers of X"), (301, "Inferno")
        e616 = (1, "Earth 616")
        stan = (900, "Stan Lee", ["Writer"])
        hickman = (901, "Jonathan Hickman", ["Writer"])
        issue(1001, 10, "1", date(1963, 3, 1), chars=[spidey], credits=[stan], universes=[e616], cv_id=6686)
        issue(1002, 10, "2", date(1963, 5, 1), chars=[spidey, mj], teams=[avengers], credits=[stan], universes=[e616])
        issue(1003, 10, "300", date(1988, 5, 1), chars=[spidey, mj], teams=[avengers], credits=[stan],
              universes=[e616], cv_id=7000)
        issue(2001, 20, "1", date(2019, 9, 1), chars=[cyclops, jean], teams=[xmen], arcs=[hoxpox], credits=[hickman],
              universes=[e616], desc="Welcome to Krakoa.")
        issue(2002, 20, "2", date(2019, 9, 15), chars=[cyclops], teams=[xmen], arcs=[hoxpox], credits=[hickman])
        issue(2201, 22, "1", date(2021, 11, 1), chars=[cyclops, jean], teams=[xmen], arcs=[inferno], credits=[hickman])
        issue(3001, 30, "1", date(2019, 12, 1), reprints=[(2001, "House of X (2019) #1"), (2002, "House of X (2019) #2"),
                                                          (2501, "Powers of X (2019) #1")])
        issue(4001, 40, "1", date(2016, 8, 1), chars=[(120, "Batman")])
        self.universes_db = {1: NS(id=1, name="Earth 616", designation="Earth-616", publisher=MARVEL, desc="", image=None,
                                   gcd_id=None, resource_url=None, modified=None)}
        self.arcs_db = {300: NS(id=300, name="House of X / Powers of X", desc="The dawn of Krakoa.", image=None,
                                cv_id=None, gcd_id=None, modified=None),
                        301: NS(id=301, name="Inferno", desc="", image=None, cv_id=None, gcd_id=None, modified=None)}
        self.characters_db = {
            100: NS(id=100, name="Spider-Man", alias=["Spidey"], desc="Friendly neighborhood.", image=None, creators=[],
                    teams=[_res(*avengers)], universes=[], cv_id=1443, gcd_id=None, modified=None),
            101: NS(id=101, name="Spider-Man (Miles Morales)", alias=[], desc="", image=None, creators=[],
                    teams=[_res(*avengers)], universes=[], cv_id=40809, gcd_id=None, modified=None),
            102: NS(id=102, name="Mary Jane Watson", alias=["MJ"], desc="", image=None, creators=[], teams=[],
                    universes=[], cv_id=None, gcd_id=None, modified=None),
            110: NS(id=110, name="Cyclops", alias=[], desc="", image=None, creators=[], teams=[_res(*xmen)],
                    universes=[], cv_id=1478, gcd_id=None, modified=None),
            111: NS(id=111, name="Jean Grey", alias=[], desc="", image=None, creators=[], teams=[_res(*xmen)],
                    universes=[], cv_id=1479, gcd_id=None, modified=None),
            120: NS(id=120, name="Batman", alias=[], desc="", image=None, creators=[], teams=[], universes=[],
                    cv_id=None, gcd_id=None, modified=None),
        }
        self.teams_db = {200: NS(id=200, name="Avengers", desc="Earth's mightiest.", image=None, creators=[], universes=[],
                                 cv_id=3806, gcd_id=None, modified=None),
                         201: NS(id=201, name="X-Men", desc="", image=None, creators=[], universes=[], cv_id=3173,
                                 gcd_id=None, modified=None)}
        self.reading_lists_db = {500: NS(id=500, name="Krakoa Essentials", desc="Start of the Krakoa era.", image=None,
                                         attribution_source="Community", list_type="Event")}
        self.reading_list_items_db = {500: [
            NS(id=1, order=2, issue_type="Tie-In", issue=self._rl_issue(2201)),
            NS(id=2, order=1, issue_type="Core Issue", issue=self._rl_issue(2001)),
        ]}

    def _rl_issue(self, issue_id: int) -> NS:
        i = self.issues_db[issue_id]
        return NS(id=i.id, series=NS(id=i.series.id, name=i.series.name, volume=i.series.volume,
                                      year_began=i.series.year_began), number=i.number, cover_date=i.cover_date,
                  store_date=None, cv_id=i.cv_id, gcd_id=None, modified=None)

    def _base(self, issue_id: int) -> NS:
        i = self.issues_db[issue_id]
        return NS(id=i.id, number=i.number, cover_date=i.cover_date, store_date=None, foc_date=None, image=i.image,
                  cover_hash="", modified=None, issue_name=i.issue_name,
                  series=NS(id=i.series.id, name=i.series.name, volume=i.series.volume, year_began=i.series.year_began))

    # ── mokkari Session surface ──
    def _log(self, name: str) -> None:
        self.calls.append(name)

    def publishers_list(self, params=None):
        self._log("publishers_list"); return [_res(1, "Marvel"), _res(2, "DC Comics"), _res(3, "Image")]

    def universe(self, _id):
        self._log(f"universe:{_id}"); return self.universes_db.get(_id)

    def series(self, _id):
        self._log(f"series:{_id}"); return self.series_db.get(_id)

    def series_issues_list(self, _id):
        self._log(f"series_issues:{_id}")
        return [self._base(i) for i, v in self.issues_db.items() if v.series.id == _id]

    def issue(self, _id):
        self._log(f"issue:{_id}"); return self.issues_db.get(_id)

    def issues_list(self, params=None):
        self._log("issues_list")
        cv = (params or {}).get("cv_id")
        return [self._base(i) for i, v in self.issues_db.items() if cv is None or v.cv_id == cv]

    def arc(self, _id):
        self._log(f"arc:{_id}"); return self.arcs_db.get(_id)

    def arc_issues_list(self, _id):
        self._log(f"arc_issues:{_id}")
        return [self._base(i) for i, v in self.issues_db.items() if any(a.id == _id for a in v.arcs)]

    def character(self, _id):
        self._log(f"character:{_id}"); return self.characters_db.get(_id)

    def character_issues_list(self, _id):
        self._log(f"character_issues:{_id}")
        return [self._base(i) for i, v in self.issues_db.items() if any(c.id == _id for c in v.characters)]

    def team(self, _id):
        self._log(f"team:{_id}"); return self.teams_db.get(_id)

    def team_issues_list(self, _id):
        self._log(f"team_issues:{_id}")
        return [self._base(i) for i, v in self.issues_db.items() if any(t.id == _id for t in v.teams)]

    def reading_list(self, _id):
        self._log(f"reading_list:{_id}"); return self.reading_lists_db.get(_id)

    def reading_list_items(self, _id):
        self._log(f"reading_list_items:{_id}"); return list(self.reading_list_items_db.get(_id, []))

    def series_list(self, params=None):
        self._log("series_list")
        name = (params or {}).get("name", "").lower()
        return [NS(id=s.id, display_name=s.display_name, year_began=s.year_began, issue_count=s.issue_count,
                   publisher=s.publisher, series_type=s.series_type, volume=s.volume, modified=None, year_end=s.year_end,
                   cv_id=s.cv_id, gcd_id=None)
                for s in self.series_db.values() if name in s.name.lower()]

    def arcs_list(self, params=None):
        return [_res(a.id, a.name) for a in self.arcs_db.values() if (params or {}).get("name", "").lower() in a.name.lower()]

    def characters_list(self, params=None):
        return [_res(c.id, c.name) for c in self.characters_db.values() if (params or {}).get("name", "").lower() in c.name.lower()]

    def teams_list(self, params=None):
        return [_res(t.id, t.name) for t in self.teams_db.values() if (params or {}).get("name", "").lower() in t.name.lower()]

    def reading_lists_list(self, params=None):
        return [_res(r.id, r.name) for r in self.reading_lists_db.values()]


def _cv_ref(id_: int, name: str = None, number: str = None) -> NS:
    return NS(id=id_, name=name, number=number, api_url="https://cv/", site_url=None)


class FakeComicvine:
    def __init__(self) -> None:
        self.calls: List[str] = []

    def get_character(self, cid: int) -> NS:
        self.calls.append(f"character:{cid}")
        data = {
            1443: dict(real_name="Peter Parker", aliases="Spidey\nWeb-Slinger", first_issue=_cv_ref(6686, "Spider-Man!", "15"),
                       deaths=[_cv_ref(7000, "Death issue")], teams=[_cv_ref(3806, "Avengers")]),
            40809: dict(real_name="Miles Morales", aliases=None, first_issue=None, deaths=[], teams=[]),
            1478: dict(real_name="Scott Summers", aliases=None, first_issue=None, deaths=[], teams=[_cv_ref(3173)]),
            1479: dict(real_name="Jean Grey", aliases="Marvel Girl\nPhoenix", first_issue=None,
                       deaths=[_cv_ref(9999, "Phoenix Saga end")], teams=[_cv_ref(3173)]),
        }[cid]
        return NS(summary=None, description="<p>From Comic Vine</p>", image=None, **data)

    def get_issue(self, iid: int) -> NS:
        self.calls.append(f"issue:{iid}")
        volumes = {6686: ("Amazing Fantasy", "15", date(1962, 8, 1)), 7000: ("Amazing Spider-Man", "300", date(1988, 5, 1))}
        vol, number, cover = volumes.get(iid, ("Some Series", "1", None))
        return NS(volume=NS(id=1, name=vol), number=number, cover_date=cover,
                  first_appearance_characters=[_cv_ref(40809)] if iid == 7000 else [],
                  first_appearance_teams=[], deaths=[_cv_ref(1479)] if iid == 7000 else [])

    def get_team(self, tid: int) -> NS:
        self.calls.append(f"team:{tid}")
        members = {3806: [_cv_ref(1443), _cv_ref(40809)], 3173: [_cv_ref(1478), _cv_ref(1479)]}[tid]
        return NS(summary="A team.", description=None, image=None, first_issue=None, issues_disbanded_in=[],
                  members=members)

    def get_story_arc(self, aid: int) -> NS:
        return NS(description="<b>Arc</b> text", summary=None, image=None)
