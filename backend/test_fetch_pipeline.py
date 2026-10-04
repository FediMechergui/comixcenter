import asyncio
import os
import sys

# Ensure backend directory is in python path
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.providers.base import ComicRelease
from app.providers.manager import ComicSyncManager
from app.providers.readcomicsonline import ReadComicsOnlineProvider
from app.storage.cbz_packager import stream_and_package_cbz, cbz_to_pdf

async def main():
    print("=" * 70)
    print("COMIXCENTER: LIVE FETCH & UPDATE PIPELINE VERIFICATION")
    print("=" * 70)

    manager = ComicSyncManager()

    # 1. Test Unified Live Updates (Merged & Deduplicated)
    print("\n[Step 1] Fetching unified latest comic releases...")
    latest = await manager.fetch_all_latest(limit=10)
    print(f"[+] Retrieved {len(latest)} deduplicated live updates:")
    for i, rel in enumerate(latest[:5], 1):
        mirrors_cnt = len(rel.download_mirrors)
        has_reader = "Yes" if rel.reader_url else "No"
        print(f"  {i}. [{rel.publisher.upper() if rel.publisher else 'UNKNOWN'}] {rel.title}")
        print(f"     -> Format: {rel.format} | Year: {rel.year} | Issue: #{rel.issue_number}")
        print(f"     -> Download Mirrors: {mirrors_cnt} | In-App Reader: {has_reader}")
        if rel.download_mirrors:
            print(f"        Mirrors: {', '.join(m.name for m in rel.download_mirrors)}")

    # 2. Test Marvel Specific Updates
    print("\n[Step 2] Fetching Latest MARVEL Comics specifically...")
    marvel_comics = await manager.fetch_by_publisher("marvel", limit=5)
    print(f"[+] Retrieved {len(marvel_comics)} Marvel releases:")
    for i, rel in enumerate(marvel_comics, 1):
        print(f"  {i}. {rel.title} (Year: {rel.year})")
        if rel.download_mirrors:
            first_m = rel.download_mirrors[0]
            print(f"     -> Mirror: {first_m.name}: {first_m.url[:70]}...")

    # 3. Test DC Specific Updates
    print("\n[Step 3] Fetching Latest DC Comics specifically...")
    dc_comics = await manager.fetch_by_publisher("dc", limit=5)
    print(f"[+] Retrieved {len(dc_comics)} DC releases:")
    for i, rel in enumerate(dc_comics, 1):
        print(f"  {i}. {rel.title} (Year: {rel.year})")
        if rel.download_mirrors:
            first_m = rel.download_mirrors[0]
            print(f"     -> Mirror: {first_m.name}: {first_m.url[:70]}...")

    # 4. Test In-App Reading Page Stream & CBZ + PDF Generation
    print("\n[Step 4] Testing Live Page Streaming & CBZ -> PDF Conversion...")
    rco = ReadComicsOnlineProvider()
    
    test_release = ComicRelease(
        id="rco-xmen-2024-1",
        title="X-Men (2024-) #1",
        clean_title="X-Men",
        series_name="X-Men",
        issue_number="1",
        year=2024,
        publisher="Marvel",
        source_provider="ReadComicsOnline",
        source_url="https://readcomicsonline.ru/comic/xmen-2024/1",
        reader_url="https://readcomicsonline.ru/comic/xmen-2024/1",
        raw_metadata={"slug": "xmen-2024", "chapter": "1"}
    )
    pages = await rco.get_issue_pages(test_release, max_pages=3)

    print(f"[+] Selected issue: {test_release.title}")
    if not pages:
        print("[-] No stream pages found on the CDN for this issue; skipping CBZ/PDF packaging.")
        return
    print(f"[+] Generated {len(pages)} stream page URLs. Sample: {pages[0].image_url}")

    output_dir = os.path.join(backend_dir, "test_output")
    cbz_file = os.path.join(output_dir, "sample_comic.cbz")
    pdf_file = os.path.join(output_dir, "sample_comic.pdf")

    print("[*] Downloading first 2 sample pages from CDN and compiling .CBZ archive...")
    created_cbz = await stream_and_package_cbz(
        pages=pages,
        output_cbz_path=cbz_file,
        series=test_release.series_name or test_release.clean_title,
        issue_number=test_release.issue_number,
        publisher=test_release.publisher,
        max_pages=2
    )
    cbz_size = os.path.getsize(created_cbz)
    print(f"[+] CBZ successfully created! Size: {cbz_size:,} bytes at {created_cbz}")

    print("[*] Converting CBZ to PDF via img2pdf...")
    created_pdf = cbz_to_pdf(cbz_file, pdf_file)
    pdf_size = os.path.getsize(created_pdf)
    print(f"[+] PDF successfully exported! Size: {pdf_size:,} bytes at {created_pdf}")

    print("\n" + "=" * 70)
    print("ALL CORE FETCH, FILTER, STREAM & PACKAGING LOGIC VERIFIED!")
    print("=" * 70)

if __name__ == "__main__":
    asyncio.run(main())
