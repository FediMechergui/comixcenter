import html
from typing import Optional

from fastapi import APIRouter, Request, Response

from app.providers.manager import ComicSyncManager

router = APIRouter(prefix="/api/feeds", tags=["feeds"])
manager = ComicSyncManager()

@router.get("/opds")
async def opds_feed(request: Request, q: Optional[str] = None):
    if q:
        releases = await manager.search_across_all(q)
    else:
        releases = await manager.fetch_all_latest(limit=30)
    
    entries = []
    for rel in releases:
        acq_links = ""
        for m in rel.download_mirrors:
            acq_links += f'<link rel="http://opds-spec.org/acquisition" href="{html.escape(m.url)}" type="application/x-cbz" title="{html.escape(m.name)}"/>\n'
        
        if rel.reader_url:
            acq_links += f'<link rel="http://opds-spec.org/acquisition/open-access" href="{html.escape(rel.reader_url)}" type="text/html" title="Read Online"/>\n'

        img = f'<link rel="http://opds-spec.org/image" href="{html.escape(rel.cover_image_url)}"/>\n' if rel.cover_image_url else ''
        
        entries.append(f"""<entry>
            <title>{html.escape(rel.title)}</title>
            <id>{html.escape(rel.id)}</id>
            <author><name>{html.escape(rel.publisher or "Unknown")}</name></author>
            <summary>{html.escape(rel.synopsis or "")}</summary>
            {img}
            {acq_links}
        </entry>""")
        
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>comixcenter:scrapers</id>
  <title>Feeds (Scrapers)</title>
  <updated>2023-01-01T00:00:00Z</updated>
  <author><name>ComixCenter</name></author>
  {"".join(entries)}
</feed>"""
    return Response(content=xml, media_type="application/atom+xml")
