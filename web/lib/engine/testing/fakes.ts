/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-memory stand-ins for the Metron, Comic Vine and GCD clients (port of
 * backend/tests/comix_app/fakes.py, plus a GCD fake shaped like the real API).
 */
import type { ComicVineApi } from "../sync/comicvine";
import type { GcdApi } from "../sync/gcd";
import type { MetronApi } from "../sync/metron";

const MARVEL = { id: 1, name: "Marvel" }, DC = { id: 2, name: "DC Comics" };
const ONGOING = { id: 1, name: "Ongoing Series" }, LIMITED = { id: 2, name: "Limited Series" }, TPB = { id: 3, name: "Trade Paperback" };
const res = (id: number, name: string) => ({ id, name });

export class FakeMetron implements MetronApi {
  calls: string[] = [];
  seriesDb: Record<number, any> = {
    10: { id: 10, name: "Amazing Spider-Man", sort_name: "Amazing Spider-Man", volume: 1, year_began: 1963, year_end: 1998, series_type: ONGOING,
      status: "Completed", desc: "Peter Parker's flagship.", issue_count: 3, cv_id: 2127, gcd_id: null, publisher: MARVEL, imprint: null, display_name: "Amazing Spider-Man (1963)" },
    20: { id: 20, name: "House of X", sort_name: "House of X", volume: 1, year_began: 2019, year_end: 2019, series_type: LIMITED, status: "Completed",
      desc: "Krakoa begins.", issue_count: 2, cv_id: null, gcd_id: null, publisher: MARVEL, imprint: null, display_name: "House of X (2019)" },
    22: { id: 22, name: "Inferno", sort_name: "Inferno", volume: 2, year_began: 2021, year_end: 2022, series_type: LIMITED, status: "Completed",
      desc: "", issue_count: 1, cv_id: null, gcd_id: null, publisher: MARVEL, imprint: null, display_name: "Inferno (2021)" },
    30: { id: 30, name: "House of X / Powers of X", sort_name: "House of X / Powers of X", volume: 1, year_began: 2019, year_end: 2019,
      series_type: TPB, status: "Completed", desc: "", issue_count: 1, cv_id: null, gcd_id: null, publisher: MARVEL, imprint: null, display_name: "House of X / Powers of X (2019)" },
    40: { id: 40, name: "Batman", sort_name: "Batman", volume: 3, year_began: 2016, year_end: null, series_type: ONGOING, status: "Ongoing",
      desc: "", issue_count: 1, cv_id: null, gcd_id: null, publisher: DC, imprint: null, display_name: "Batman (2016)" },
  };
  issuesDb: Record<number, any> = {};
  universesDb: Record<number, any> = { 1: { id: 1, name: "Earth 616", designation: "Earth-616", publisher: MARVEL, desc: "" } };
  arcsDb: Record<number, any> = {
    300: { id: 300, name: "House of X / Powers of X", desc: "The dawn of Krakoa.", image: null, cv_id: null },
    301: { id: 301, name: "Inferno", desc: "", image: null, cv_id: null },
  };
  charactersDb: Record<number, any> = {
    100: { id: 100, name: "Spider-Man", alias: ["Spidey"], desc: "Friendly neighborhood.", image: null, teams: [res(200, "Avengers")], cv_id: 1443 },
    101: { id: 101, name: "Spider-Man (Miles Morales)", alias: [], desc: "", image: null, teams: [res(200, "Avengers")], cv_id: 40809 },
    102: { id: 102, name: "Mary Jane Watson", alias: ["MJ"], desc: "", image: null, teams: [], cv_id: null },
    110: { id: 110, name: "Cyclops", alias: [], desc: "", image: null, teams: [res(201, "X-Men")], cv_id: 1478 },
    111: { id: 111, name: "Jean Grey", alias: [], desc: "", image: null, teams: [res(201, "X-Men")], cv_id: 1479 },
    120: { id: 120, name: "Batman", alias: [], desc: "", image: null, teams: [], cv_id: null },
  };
  teamsDb: Record<number, any> = {
    200: { id: 200, name: "Avengers", desc: "Earth's mightiest.", image: null, cv_id: 3806 },
    201: { id: 201, name: "X-Men", desc: "", image: null, cv_id: 3173 },
  };
  readingListsDb: Record<number, any> = { 500: { id: 500, name: "Krakoa Essentials", desc: "Start of the Krakoa era.", attribution_source: "Community" } };

  constructor() {
    const spidey = res(100, "Spider-Man"), mj = res(102, "Mary Jane Watson"), cyclops = res(110, "Cyclops"), jean = res(111, "Jean Grey");
    const avengers = res(200, "Avengers"), xmen = res(201, "X-Men"), hoxpox = res(300, "House of X / Powers of X"), inferno = res(301, "Inferno");
    const e616 = res(1, "Earth 616");
    const stan = { id: 900, creator: "Stan Lee", role: [{ id: 1, name: "Writer" }] };
    const hickman = { id: 901, creator: "Jonathan Hickman", role: [{ id: 1, name: "Writer" }] };
    const issue = (id: number, seriesId: number, number: string, cover: string, o: any = {}) => {
      const s = this.seriesDb[seriesId];
      this.issuesDb[id] = {
        id, number, cover_date: cover, store_date: null, image: `https://static.metron.cloud/${id}.jpg`,
        issue_name: `${s.name} (${s.year_began}) #${number}`,
        series: { id: s.id, name: s.name, sort_name: s.sort_name, volume: s.volume, year_began: s.year_began, series_type: s.series_type },
        publisher: s.publisher, imprint: null, collection_title: "", story_titles: [`Story ${number}`], isbn: "", upc: "", page_count: 32,
        desc: o.desc ?? "", arcs: o.arcs ?? [], credits: o.credits ?? [], characters: o.chars ?? [], teams: o.teams ?? [],
        universes: o.universes ?? [], reprints: o.reprints ?? [], cv_id: o.cv_id ?? null, gcd_id: null,
      };
    };
    issue(1001, 10, "1", "1963-03-01", { chars: [spidey], credits: [stan], universes: [e616], cv_id: 6686 });
    issue(1002, 10, "2", "1963-05-01", { chars: [spidey, mj], teams: [avengers], credits: [stan], universes: [e616] });
    issue(1003, 10, "300", "1988-05-01", { chars: [spidey, mj], teams: [avengers], credits: [stan], universes: [e616], cv_id: 7000 });
    issue(2001, 20, "1", "2019-09-01", { chars: [cyclops, jean], teams: [xmen], arcs: [hoxpox], credits: [hickman], universes: [e616], desc: "Welcome to Krakoa." });
    issue(2002, 20, "2", "2019-09-15", { chars: [cyclops], teams: [xmen], arcs: [hoxpox], credits: [hickman] });
    issue(2201, 22, "1", "2021-11-01", { chars: [cyclops, jean], teams: [xmen], arcs: [inferno], credits: [hickman] });
    issue(3001, 30, "1", "2019-12-01", { reprints: [{ id: 2001, issue: "House of X (2019) #1" }, { id: 2002, issue: "House of X (2019) #2" }, { id: 2501, issue: "Powers of X (2019) #1" }] });
    issue(4001, 40, "1", "2016-08-01", { chars: [res(120, "Batman")] });
  }

  private base(id: number) {
    const i = this.issuesDb[id];
    return { id: i.id, number: i.number, cover_date: i.cover_date, store_date: null, image: i.image, issue_name: i.issue_name,
      series: { id: i.series.id, name: i.series.name, volume: i.series.volume, year_began: i.series.year_began } };
  }
  private log(n: string) { this.calls.push(n); }

  async publishersList() { this.log("publishers_list"); return [res(1, "Marvel"), res(2, "DC Comics"), res(3, "Image")]; }
  async universe(id: number) { this.log(`universe:${id}`); return this.universesDb[id] ?? null; }
  async series(id: number) { this.log(`series:${id}`); return this.seriesDb[id] ?? null; }
  async seriesList(p: any = {}) {
    const name = String(p.name ?? "").toLowerCase();
    return Object.values(this.seriesDb).filter((s: any) => s.name.toLowerCase().includes(name)).map((s: any) => ({ ...s }));
  }
  async seriesIssuesList(id: number) { this.log(`series_issues:${id}`); return Object.values(this.issuesDb).filter((i: any) => i.series.id === id).map((i: any) => this.base(i.id)); }
  async issue(id: number) { this.log(`issue:${id}`); return this.issuesDb[id] ?? null; }
  async issuesList(p: any = {}) { return Object.values(this.issuesDb).filter((i: any) => p.cv_id == null || i.cv_id === p.cv_id).map((i: any) => this.base(i.id)); }
  async arc(id: number) { return this.arcsDb[id] ?? null; }
  async arcsList(p: any = {}) { return Object.values(this.arcsDb).filter((a: any) => a.name.toLowerCase().includes(String(p.name ?? "").toLowerCase())).map((a: any) => res(a.id, a.name)); }
  async arcIssuesList(id: number) { return Object.values(this.issuesDb).filter((i: any) => i.arcs.some((a: any) => a.id === id)).map((i: any) => this.base(i.id)); }
  async character(id: number) { this.log(`character:${id}`); return this.charactersDb[id] ?? null; }
  async charactersList(p: any = {}) { return Object.values(this.charactersDb).filter((c: any) => c.name.toLowerCase().includes(String(p.name ?? "").toLowerCase())).map((c: any) => res(c.id, c.name)); }
  async characterIssuesList(id: number) { return Object.values(this.issuesDb).filter((i: any) => i.characters.some((c: any) => c.id === id)).map((i: any) => this.base(i.id)); }
  async team(id: number) { this.log(`team:${id}`); return this.teamsDb[id] ?? null; }
  async teamsList(p: any = {}) { return Object.values(this.teamsDb).filter((t: any) => t.name.toLowerCase().includes(String(p.name ?? "").toLowerCase())).map((t: any) => res(t.id, t.name)); }
  async teamIssuesList(id: number) { return Object.values(this.issuesDb).filter((i: any) => i.teams.some((t: any) => t.id === id)).map((i: any) => this.base(i.id)); }
  async readingList(id: number) { return this.readingListsDb[id] ?? null; }
  async readingListsList() { return Object.values(this.readingListsDb).map((r: any) => res(r.id, r.name)); }
  async readingListItems(id: number) {
    if (id !== 500) return [];
    const rl = (iid: number) => { const i = this.issuesDb[iid]; return { id: i.id, series: { id: i.series.id, name: i.series.name, volume: i.series.volume, year_began: i.series.year_began }, number: i.number, cover_date: i.cover_date, cv_id: i.cv_id }; };
    return [{ id: 1, order: 2, issue_type: "Tie-In", issue: rl(2201) }, { id: 2, order: 1, issue_type: "Core Issue", issue: rl(2001) }];
  }
}

const cvRef = (id: number, name: string | null = null, number: string | null = null) => ({ id, name, number });

export class FakeComicVine implements ComicVineApi {
  calls: string[] = [];
  async getCharacter(id: number) {
    this.calls.push(`character:${id}`);
    const data: Record<number, any> = {
      1443: { real_name: "Peter Parker", aliases: "Spidey\nWeb-Slinger", first_issue: cvRef(6686, "Spider-Man!", "15"), deaths: [cvRef(7000, "Death issue")], teams: [cvRef(3806, "Avengers")] },
      40809: { real_name: "Miles Morales", aliases: null, first_issue: null, deaths: [], teams: [] },
      1478: { real_name: "Scott Summers", aliases: null, first_issue: null, deaths: [], teams: [cvRef(3173)] },
      1479: { real_name: "Jean Grey", aliases: "Marvel Girl\nPhoenix", first_issue: null, deaths: [cvRef(9999, "Phoenix Saga end")], teams: [cvRef(3173)] },
    };
    return { summary: null, description: "<p>From Comic Vine</p>", image: null, ...data[id] };
  }
  async getIssue(id: number) {
    this.calls.push(`issue:${id}`);
    const vols: Record<number, [string, string, string | null]> = { 6686: ["Amazing Fantasy", "15", "1962-08-01"], 7000: ["Amazing Spider-Man", "300", "1988-05-01"] };
    const [vol, number, cover] = vols[id] ?? ["Some Series", "1", null];
    return { volume: { id: 1, name: vol }, number, cover_date: cover, first_appearance_characters: id === 7000 ? [cvRef(40809)] : [],
      first_appearance_teams: [], deaths: id === 7000 ? [cvRef(1479)] : [] };
  }
  async getTeam(id: number) {
    this.calls.push(`team:${id}`);
    const members: Record<number, any[]> = { 3806: [cvRef(1443), cvRef(40809)], 3173: [cvRef(1478), cvRef(1479)] };
    return { summary: "A team.", description: null, image: null, first_issue: null, issues_disbanded_in: [], members: members[id] ?? [] };
  }
  async getStoryArc() { return { description: "<b>Arc</b> text", summary: null, image: null }; }
}

/** GCD fake with real-API shapes (ids parsed from api_url as the client does). */
export class FakeGcd implements GcdApi {
  calls: string[] = [];
  publishers: Record<number, any> = { 78: { id: 78, name: "Marvel", country: "us", year_began: 1939 }, 3: { id: 3, name: "Image", country: "us", year_began: 1992 },
    2547: { id: 2547, name: "Glénat", country: "fr", year_began: 1969 } };
  seriesDb: Record<number, any> = {
    66221: { id: 66221, name: "Saga", year_began: 2012, year_ended: null, publisher_id: 3, publishing_format: "ongoing series", notes: "",
      country: "us", language: "en", active_issue_ids: [900001, 900002, 900003], issue_descriptors: ["1", "1 [Variant Cover]", "2"] },
    7777: { id: 7777, name: "Astérix", year_began: 1961, year_ended: null, publisher_id: 2547, publishing_format: "album", notes: "",
      country: "fr", language: "fr", active_issue_ids: [700001], issue_descriptors: ["1"] },
  };
  issuesDb: Record<number, any> = {
    900001: { id: 900001, series_id: 66221, number: "1", descriptor: "1", title: "", key_date: "2012-03-00", on_sale_date: "2012-03-14",
      page_count: "44.000", isbn: "", barcode: "70985301819400111", variant_of: null, cover: "https://files1.comics.org//img/gcd/covers_by_id/1/w400/1.jpg",
      story_set: [
        { type: "cover", title: "", script: "", pencils: "Fiona Staples", inks: "Fiona Staples", colors: "Fiona Staples", letters: "", editing: "", genre: "", characters: "", synopsis: "" },
        { type: "comic story", title: "Chapter One", script: "Brian K. Vaughan", pencils: "Fiona Staples", inks: "Fiona Staples", colors: "Fiona Staples",
          letters: "Fonografiks", editing: "", genre: "science fiction; fantasy", characters: "Alana; Marko; Hazel (first appearance); The Will", synopsis: "Two soldiers from warring worlds run with their newborn." },
      ] },
    900002: { id: 900002, series_id: 66221, number: "1", descriptor: "1 [Variant Cover]", variant_of: "https://www.comics.org/api/issue/900001/?format=json", story_set: [] },
    900003: { id: 900003, series_id: 66221, number: "2", descriptor: "2", title: "", key_date: "2012-04-00", on_sale_date: "", page_count: "32.000",
      isbn: "", barcode: "", variant_of: null, cover: "https://files1.comics.org//img/gcd/covers_by_id/1/w400/3.jpg",
      story_set: [{ type: "comic story", title: "Chapter Two", script: "Brian K. Vaughan", pencils: "Fiona Staples", inks: "", colors: "", letters: "",
        editing: "", genre: "science fiction", characters: "Alana; Marko; The Will", synopsis: "The chase continues." }] },
    700001: { id: 700001, series_id: 7777, number: "1", descriptor: "1", title: "Astérix le Gaulois", key_date: "1961-10-00", on_sale_date: "",
      page_count: "48.000", isbn: "", barcode: "", variant_of: null, cover: "https://files1.comics.org//img/gcd/covers_by_id/2/w400/2.jpg",
      story_set: [{ type: "comic story", title: "Astérix le Gaulois", script: "René Goscinny", pencils: "Albert Uderzo", inks: "Albert Uderzo",
        colors: "", letters: "", editing: "", genre: "humor", characters: "Astérix; Obélix; Panoramix; Romans", synopsis: "The Gauls resist Rome." }] },
  };
  async searchSeries(name: string, year?: number | null) {
    this.calls.push(`search:${name}`);
    return Object.values(this.seriesDb).filter((s) => s.name.toLowerCase().includes(name.toLowerCase()) && (!year || s.year_began === year));
  }
  async series(id: number) { this.calls.push(`series:${id}`); return this.seriesDb[id]; }
  async issue(id: number) { this.calls.push(`issue:${id}`); return this.issuesDb[id]; }
  async publisher(id: number) { this.calls.push(`publisher:${id}`); return this.publishers[id]; }
}
