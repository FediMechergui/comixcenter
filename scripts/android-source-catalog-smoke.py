"""Validate saved listings and public Batcave section entry points in the installed APK."""
import argparse
import asyncio
import json
import re
import runpy
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

b = runpy.run_path(str(Path(__file__).with_name("android-smoke.py")))
adb, evaluate, screenshot, targets, CDPConnection = [b[n] for n in ("adb", "evaluate", "screenshot", "targets", "CDPConnection")]

async def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--label", default="source-catalog-current"); args = parser.parse_args()
    folder = Path("scratch/android-validation") / args.label; folder.mkdir(parents=True, exist_ok=True)
    report = {"checks": {}, "measurements": {}, "source_availability": {}, "failures": []}
    app = await CDPConnection(next(t for t in targets() if t.get("type") == "page" and t["url"].startswith("http://localhost/"))["webSocketDebuggerUrl"]).connect()

    async def wait(js, connection=app, timeout=35):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                result = await evaluate(connection, js)
                if result: return result
            except Exception: pass
            await asyncio.sleep(.2)
        raise RuntimeError("UI timeout: " + js[:100])

    async def home():
        await evaluate(app, 'window.__comixLeaving=true;location.href="/"')
        await wait('!window.__comixLeaving && !!document.querySelector("#latest select")')

    async def close_source():
        adb("shell", "uiautomator", "dump", "/sdcard/comix-validation.xml")
        tree = ET.fromstring(adb("shell", "cat", "/sdcard/comix-validation.xml"))
        node = next(n for n in tree.iter("node") if n.get("text", "").lower() == "close")
        x1,y1,x2,y2 = map(int, re.findall(r"\d+", node.get("bounds")))
        adb("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
        await wait('[...document.querySelectorAll("button")].some(b=>b.textContent==="Open selected section in app" && !b.disabled)')

    try:
        await home()
        await wait('JSON.parse(localStorage.getItem("comix.catalog-cache.v1")||"[]").some(r=>r.data.entries.length>0)')
        report["checks"]["live_catalog_persisted"] = True
        adb("shell", "svc", "wifi", "disable"); adb("shell", "svc", "data", "disable")
        start = time.monotonic(); await home()
        await wait('document.body.innerText.includes("Showing saved listings") && document.querySelectorAll("#latest .list-row, #latest .discovery-book").length>0')
        report["measurements"]["offline_saved_listings_ms"] = round((time.monotonic()-start)*1000)
        report["checks"]["offline_saved_listings_visible"] = True
        await evaluate(app, 'document.getElementById("latest").scrollIntoView({behavior:"instant",block:"start"})')
        await asyncio.sleep(.5)
        await screenshot(folder, "01-saved-listings-offline")
        adb("shell", "svc", "wifi", "enable"); adb("shell", "svc", "data", "enable")
        await asyncio.sleep(2); await home()
        for path, title in [("/characters/", "Characters"), ("/event/", "Events"), ("/folder/", "Guides")]:
            await evaluate(app, f'(()=>{{const s=document.querySelector("#latest select");s.value={json.dumps(path)};s.dispatchEvent(new Event("change",{{bubbles:true}}));}})()')
            await asyncio.sleep(.2)
            start = time.monotonic()
            await evaluate(app, '[...document.querySelectorAll("button")].find(b=>b.textContent==="Open selected section in app").click()')
            target = None
            for _ in range(100):
                target = next((t for t in targets() if t.get("type") == "page" and urllib.parse.urlparse(t["url"]).hostname == "batcave.biz" and urllib.parse.urlparse(t["url"]).path == path), None)
                if target: break
                await asyncio.sleep(.2)
            if not target: raise RuntimeError("Section did not open in native source view: " + path)
            source = await CDPConnection(target["webSocketDebuggerUrl"]).connect()
            try:
                try:
                    await wait('!!document.body && (!!document.querySelector("h1")?.textContent || /Just a moment|Access denied/i.test(document.title))', source, timeout=60)
                except RuntimeError:
                    pass  # Record unavailable/slow source separately from opening the requested section.
                state = await evaluate(source, '({title:document.title,has_bridge:typeof window.Capacitor!=="undefined",heading:document.querySelector("h1")?.textContent||"",body_present:!!document.body?.innerText.trim()})')
                report["measurements"][title.lower()+"_document_ready_ms"] = round((time.monotonic()-start)*1000)
                report["checks"][title.lower()+"_opens_requested_section"] = True
                report["checks"][title.lower()+"_has_no_native_bridge"] = not state["has_bridge"]
                report["source_availability"][title] = state
                await screenshot(folder, title.lower()+"-source")
            finally:
                await source.close(); await close_source()
        if not all(report["checks"].values()): raise RuntimeError("A source catalog check failed")
    except Exception as error:
        report["failures"].append(str(error)); await screenshot(folder, "failure"); raise
    finally:
        adb("shell", "svc", "wifi", "enable"); adb("shell", "svc", "data", "enable")
        await app.close(); (folder / "report.json").write_text(json.dumps(report, indent=2)); print(json.dumps(report, indent=2), flush=True)

if __name__ == "__main__": asyncio.run(main())
