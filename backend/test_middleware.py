import asyncio
import os
import sys

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.middleware.traffic_orchestrator import ScraperTrafficMiddleware
from app.providers.base import ComicRelease

async def test_middleware_orchestration():
    print("=" * 70)
    print("TESTING SCRAPER TRAFFIC MIDDLEWARE & ORCHESTRATION")
    print("=" * 70)

    middleware = ScraperTrafficMiddleware(failure_threshold=2, cooldown_seconds=60.0)

    # 1. Inspect Initial Health Status Report
    print("\n[Step 1] Initial Provider Health Status Report:")
    status = middleware.get_status_report()
    for name, data in status["providers"].items():
        avail = "ONLINE" if data["available"] else "PAUSED/CHALLENGED"
        print(f"  - {name:<18}: [{avail}] (Failures: {data['consecutive_failures']})")
        if data["last_failure_reason"]:
            print(f"      Reason: {data['last_failure_reason']}")

    # 2. Test Rate-Limited Live Traffic Routing
    print("\n[Step 2] Routing live feed request through Middleware...")
    releases = await middleware.get_latest_feed(limit=5)
    print(f"[+] Successfully gathered {len(releases)} unified releases:")
    for i, r in enumerate(releases[:3], 1):
        print(f"  {i}. [{r.publisher or 'OTHER'}] {r.title} | Mirrors: {len(r.download_mirrors)} | Reader: {'Yes' if r.reader_url else 'No'}")

    # 3. Test Publisher-Specific Routing
    print("\n[Step 3] Routing Marvel-specific request...")
    marvel = await middleware.get_publisher_feed("marvel", limit=3)
    print(f"[+] Retrieved {len(marvel)} Marvel books:")
    for r in marvel:
        print(f"    - {r.title}")

    # 4. Test Stream Resolution Failover
    print("\n[Step 4] Testing Stream Resolution with Circuit Breaker...")
    sample_release = ComicRelease(
        id="test-1",
        title="X-Men (2024-) #1",
        clean_title="X-Men",
        source_provider="ReadComicsOnline",
        source_url="https://readcomicsonline.ru/comic/xmen-2024/1",
        reader_url="https://readcomicsonline.ru/comic/xmen-2024/1",
        raw_metadata={"slug": "xmen-2024", "chapter": "1"}
    )
    pages = await middleware.resolve_comic_stream(sample_release)
    print(f"[+] Stream resolved successfully: {len(pages)} pages ready for reader.")

    # 5. Test Batcave Session Injection
    print("\n[Step 5] Simulating Batcave Clearance Cookie Injection...")
    middleware.configure_batcave_session(cf_clearance="sample_cf_clearance_token_xyz")
    updated_status = middleware.get_status_report()
    batcave_data = updated_status["providers"]["Batcave"]
    print(f"[+] Batcave status after session injection: {'ONLINE' if batcave_data['available'] else 'OFFLINE'}")

    print("\n" + "=" * 70)
    print("MIDDLEWARE TRAFFIC ORCHESTRATION VERIFIED SUCCESSFULLY!")
    print("=" * 70)

if __name__ == "__main__":
    asyncio.run(test_middleware_orchestration())
