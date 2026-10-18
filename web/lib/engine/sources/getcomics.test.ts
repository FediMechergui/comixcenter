import { afterEach, describe, expect, it } from "vitest";

import { setHttp } from "../clients";
import { fetchGetComicsOpds, GETCOMICS_FEED } from "./getcomics";
import { mockHttp, respond } from "./test-helpers";

const POSTS = "https://getcomics.org/wp-json/wp/v2/posts";

/**
 * Shaped after a real response: the download buttons are plain-http /dls/ redirectors, the
 * other mirrors point at landing pages, and the label sits on its own line inside the anchor.
 */
const CONTENT = `
<p><img src="https://getcomics.org/share/uploads/2026/10/inline.jpg" alt=""/></p>
<h2>The Story &#8211;</h2>
<p>Sonja faces <em>the Master</em>.</p>
<div class="aio-button-center">
  <a href="http://getcomics.org/dls/abc+123=:xyz" target="_blank" rel="nofollow">
    <span class="aio-icon-title">DOWNLOAD NOW</span>
  </a>
</div>
<a href="https://1024terabox.com/s/1Xsww4l9DNKv71TT3LF7Syg">TERABOX</a>
<a href="https://vikingfile.com/f/Azr6PvY4gs">VIKINGFILE</a>
<a href="https://datanodes.to/hu8zbtcbjpri/Red_Sonja_v03.zip">DATANODES</a>
<a href="https://readcomicsonline.ru/comic/red-sonja-2023">READ ONLINE</a>
<a href="https://getcomics.info/how-to-download/">how-to download page</a>
`;

const post = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: { rendered: "Red Sonja Vol. 3 &#8211; The Master Falls (TPB) (2026)" },
  content: { rendered: CONTENT },
  excerpt: { rendered: "<p>Fallback excerpt</p>" },
  _embedded: { "wp:featuredmedia": [{ source_url: "https://getcomics.org/share/uploads/2026/10/cover.jpg" }] },
  ...over,
});

function setup(route: (url: string) => ReturnType<typeof respond> | undefined) {
  const http = mockHttp(route);
  setHttp(http);
  return http;
}

afterEach(() => setHttp(null));

describe("GetComics feed", () => {
  it("reads the WordPress API directly, as a browser, with the covers embedded", async () => {
    const http = setup((url) => (url.startsWith(POSTS) ? respond(200, [post()]) : undefined));
    const feed = await fetchGetComicsOpds(GETCOMICS_FEED.url);

    const { url, req } = http.calls[0];
    expect(url).toBe(`${POSTS}?page=1&per_page=20&_embed=1`);
    expect(req.headers!["User-Agent"]).toMatch(/^Mozilla\/5\.0 /);
    expect(feed.entries[0].cover).toBe("https://getcomics.org/share/uploads/2026/10/cover.jpg");
  });

  it("decodes the entities WordPress leaves in titles and summaries", async () => {
    setup(() => respond(200, [post()]));
    const [entry] = (await fetchGetComicsOpds(GETCOMICS_FEED.url)).entries;
    expect(entry.title).toBe("Red Sonja Vol. 3 – The Master Falls (TPB) (2026)");
    expect(entry.summary).toBe("Sonja faces the Master.");
  });

  it("offers only the direct download, upgraded to https so Android follows the redirect", async () => {
    setup(() => respond(200, [post()]));
    const [entry] = (await fetchGetComicsOpds(GETCOMICS_FEED.url)).entries;
    // Plain http would stop at the 301: HttpURLConnection will not change protocol on a redirect.
    expect(entry.acquisitions).toEqual([
      { href: "https://getcomics.org/dls/abc+123=:xyz", type: "application/zip", rel: "http://opds-spec.org/acquisition" },
    ]);
  });

  it("keeps the read-in-a-browser link so downloading stays optional", async () => {
    setup(() => respond(200, [post()]));
    const [entry] = (await fetchGetComicsOpds(GETCOMICS_FEED.url)).entries;
    expect(entry.reader_url).toBe("https://readcomicsonline.ru/comic/red-sonja-2023");
    // The reader is never offered as a file: it is a web page, not an archive.
    expect(entry.acquisitions.map((a) => a.href)).not.toContain(entry.reader_url);
  });

  it("leaves reader_url null when the post only offers downloads", async () => {
    setup(() => respond(200, [post({ content: { rendered: CONTENT.replace(/<a href="https:\/\/readcomicsonline[^<]*<\/a>/, "") } })]));
    const [entry] = (await fetchGetComicsOpds(GETCOMICS_FEED.url)).entries;
    expect(entry.reader_url).toBeNull();
    expect(entry.acquisitions).toHaveLength(1);
  });

  it("falls back to the excerpt and the inline image when the post has neither", async () => {
    setup(() => respond(200, [post({ content: { rendered: CONTENT.replace(/<h2>[\s\S]*?<\/p>/, "") }, _embedded: undefined })]));
    const [entry] = (await fetchGetComicsOpds(GETCOMICS_FEED.url)).entries;
    expect(entry.summary).toBe("Fallback excerpt");
    expect(entry.cover).toBe("https://getcomics.org/share/uploads/2026/10/inline.jpg");
  });

  it("skips posts with no title, and sponsored articles that carry no mirror at all", async () => {
    setup(() => respond(200, [
      post({ title: { rendered: "" } }),
      post({ content: { rendered: '<p>Sponsored <a href="https://evo-verse.com/x">read more</a></p>' } }),
      post(),
    ]));
    const { entries } = await fetchGetComicsOpds(GETCOMICS_FEED.url);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toMatch(/Red Sonja/);
  });

  it("keeps a comic whose only mirrors are web pages, with nothing to download", async () => {
    // Datanodes, MEGA, Pixeldrain and TeraBox all land on a host's own page, not on a file.
    const mirrorsOnly = `
      <a href="https://datanodes.to/abc/Book.zip">DATANODES</a>
      <a href="https://mega.nz/file/abc">MEGA</a>
      <a href="http://getcomics.org/dls/tok">PIXELDRAIN</a>`;
    setup(() => respond(200, [post({ content: { rendered: mirrorsOnly } })]));
    const [entry] = (await fetchGetComicsOpds(GETCOMICS_FEED.url)).entries;
    expect(entry.acquisitions).toEqual([]);
    expect(entry.reader_url).toBeNull();
  });

  it("pages forward only while the page is full", async () => {
    setup(() => respond(200, Array.from({ length: 20 }, () => post())));
    const full = await fetchGetComicsOpds(GETCOMICS_FEED.url);
    expect(full.next).toBe("getcomics://latest?page=2");
    expect(full.previous).toBeNull();

    setHttp(null);
    setup(() => respond(200, [post()]));
    const last = await fetchGetComicsOpds("getcomics://latest?page=3");
    expect(last.next).toBeNull();
    expect(last.previous).toBe("getcomics://latest?page=2");
  });

  it("treats the 400 past the last page as the end, but reports a real failure", async () => {
    setup(() => respond(400, { code: "rest_post_invalid_page_number" }));
    const feed = await fetchGetComicsOpds("getcomics://latest?page=99");
    expect(feed.entries).toEqual([]);
    expect(feed.next).toBeNull();

    setHttp(null);
    setup(() => respond(503, "down"));
    await expect(fetchGetComicsOpds(GETCOMICS_FEED.url)).rejects.toThrow(/503/);
  });
});
