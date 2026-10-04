import { describe, expect, it } from "vitest";
import { OpdsError, parseOpdsFeed } from "./opds";

const OPDS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
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
</feed>`;

const BASE = "https://komga.local/opds/v1.2/catalog";

describe("parseOpdsFeed", () => {
  it("splits navigation and publications like the Python parser", () => {
    const feed = parseOpdsFeed(OPDS_FEED, BASE);
    expect(feed.title).toBe("My Komga");
    const [nav, pub] = feed.entries;
    expect(nav).toEqual({
      title: "Saga", summary: null, author: null, cover: null, kind: "navigation",
      href: "https://komga.local/opds/v1.2/series/1", acquisitions: [],
    });
    expect(pub.kind).toBe("publication");
    expect(pub.summary).toBe("Issue one");
    expect(pub.acquisitions).toEqual([{                // buy link ignored
      href: "https://komga.local/opds/v1.2/books/1/file", type: "application/vnd.comicbook+zip",
      rel: "http://opds-spec.org/acquisition",
    }]);
    expect(pub.cover).toBe("https://komga.local/thumb/1.jpg");
    expect(feed.next).toBe("https://komga.local/opds/v1.2/series?page=2");
    expect(feed.previous).toBeNull();
    expect(feed.up).toBeNull();
  });

  it("prefers full covers over thumbnails, reads authors and falls back from up to start", () => {
    const feed = parseOpdsFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
      <link rel="start" href="../root.xml"/>
      <entry><title> </title><content>  Body  </content><author><name>Brian K. Vaughan</name></author>
        <link rel="http://opds-spec.org/image" href="big.jpg"/>
        <link rel="http://opds-spec.org/image/thumbnail" href="small.jpg"/>
        <link rel="http://opds-spec.org/acquisition/open-access" href="free.cbz" type="application/zip; charset=x"/>
        <link rel="http://opds-spec.org/acquisition/sample" href="sample.cbz"/>
      </entry></feed>`, "https://lib.example/opds/feeds/new.xml");
    expect(feed.up).toBe("https://lib.example/opds/root.xml");
    const [entry] = feed.entries;
    expect(entry.title).toBe("");          // " " is truthy, so Python strips it rather than saying "Untitled"
    expect(entry.summary).toBe("Body");
    expect(entry.author).toBe("Brian K. Vaughan");
    expect(entry.cover).toBe("https://lib.example/opds/feeds/big.jpg");
    expect(entry.acquisitions).toEqual([{
      href: "https://lib.example/opds/feeds/free.cbz", type: "application/zip",
      rel: "http://opds-spec.org/acquisition/open-access",
    }]);
  });

  it("rejects documents that are not Atom feeds", () => {
    expect(() => parseOpdsFeed("<html><body>login</body></html>", BASE)).toThrow(OpdsError);
    expect(() => parseOpdsFeed("<feed><title>no namespace</title></feed>", BASE)).toThrow(OpdsError);
    expect(() => parseOpdsFeed("not xml", BASE)).toThrow(OpdsError);
  });
});
