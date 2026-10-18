import { describe, expect, it } from "vitest";
import { embeddedData, isBatcave, parseBatcaveCatalog } from "./batcave";

const document = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("Batcave source", () => {
  it("reads embedded JSON without executing any scripts", () => {
    const doc = document('<script>window.__DATA__ = {"news_id":12,"title":"A } quoted brace","chapters":[{"id":9}]}; throw new Error("do not run");</script>');
    expect(embeddedData(doc)).toMatchObject({ news_id: 12, chapters: [{ id: 9 }], title: "A } quoted brace" });
  });
  it("rejects an imitation source domain and embedded credentials", () => {
    expect(isBatcave("https://batcave.biz/123-title.html")).toBe(true);
    expect(isBatcave("https://batcave.biz.evil.test/123-title.html")).toBe(false);
    expect(isBatcave("https://user:pass@batcave.biz/title")).toBe(false);
  });
  it("deduplicates listings and preserves the comic link instead of the update link", () => {
    const row = '<li class="latest"><a href="/123-title.html"><img src="/uploads/mini/cover.webp"></a><p class="latest__title">Example</p><p class="latest__chapter"><a href="/reader/123/55">18.10.2026 - Example #2</a></p></li>';
    const result = parseBatcaveCatalog(document(row + row));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: "Example #2", reader_url: "https://batcave.biz/123-title.html", cover: "https://batcave.biz/uploads/mini/cover.webp" });
  });
  it("fails clearly when the source has no reader data", () => {
    expect(() => embeddedData(document("<title>Just a moment</title>"))).toThrow("reader data");
  });
});
