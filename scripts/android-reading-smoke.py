"""End-to-end source resume, local import, offline reader and backup UI checks."""
import asyncio
import argparse
import base64
import io
import json
import re
import runpy
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

base = runpy.run_path(str(Path(__file__).with_name("android-smoke.py")))
adb, evaluate, screenshot, targets = [base[n] for n in ("adb", "evaluate", "screenshot", "targets")]
CDPConnection = base["CDPConnection"]


async def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--label", default="reading-current"); parser.add_argument("--skip-source", action="store_true"); args = parser.parse_args()
    folder = Path("scratch/android-validation") / args.label
    folder.mkdir(parents=True, exist_ok=True)
    report = {"measurements": {}, "checks": {}, "failures": []}
    adb("shell", "am", "force-stop", "app.comixcenter")
    adb("shell", "am", "start", "-n", "app.comixcenter/.MainActivity")
    for _ in range(40):
        try:
            pid = adb("shell", "pidof", "app.comixcenter").decode().strip()
            adb("forward", "tcp:9224", "localabstract:webview_devtools_remote_" + pid)
            if any("localhost" in t["url"] for t in targets()): break
        except Exception: pass
        await asyncio.sleep(.25)
    app = await CDPConnection(next(t for t in targets() if "localhost" in t["url"])["webSocketDebuggerUrl"]).connect()

    async def wait(js, connection=app, timeout=30):
        until = time.monotonic() + timeout
        last_error = None
        first = True
        while time.monotonic() < until:
            try:
                value = await evaluate(connection, js)
                if first:
                    print("UI probe:", js[:70], "=>", str(value)[:100], flush=True)
                    first = False
                if value:
                    return value
            except Exception as error:
                if last_error != str(error):
                    last_error = str(error)
                    print("Waiting for UI:", type(error).__name__, str(error)[:250], flush=True)
            await asyncio.sleep(.25)
        raise RuntimeError("UI readiness timeout: " + js[:140] + ("; " + last_error[:250] if last_error else ""))

    async def navigate(path, ready):
        await evaluate(app, "window.__comixLeaving=true;location.href=" + json.dumps(path))
        await wait("!window.__comixLeaving && !!document.body && (" + ready + ")")

    async def close_source():
        adb("shell", "uiautomator", "dump", "/sdcard/comix-validation.xml")
        tree = ET.fromstring(adb("shell", "cat", "/sdcard/comix-validation.xml").decode())
        close = next(n for n in tree.iter("node") if n.get("text", "").lower() == "close")
        x1,y1,x2,y2 = map(int, re.findall(r"\d+", close.get("bounds")))
        adb("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
        await asyncio.sleep(1)

    try:
        await wait('location.origin === "http://localhost" && !!document.body && document.body.innerText.includes("Explore online comics")', timeout=45)
        if not args.skip_source:
            comic = "https://batcave.biz/reader/33459/239119"
            start = time.monotonic()
            await evaluate(app, "location.href=" + json.dumps("/read-online?" + urllib.parse.urlencode({"url":comic,"title":"Adventure Time validation"})))
            for _ in range(60):
                source = next((t for t in targets() if urllib.parse.urlparse(t["url"]).hostname == "batcave.biz" and t.get("type") == "page"), None)
                if source and source.get("title"):
                    break
                await asyncio.sleep(.25)
            else:
                raise RuntimeError("Read did not open the native source reader")
            report["measurements"]["read_to_source_view_ms"] = round((time.monotonic()-start)*1000)
            source = await CDPConnection(source["webSocketDebuggerUrl"]).connect()
            print("Source attached:", source.ws_url, flush=True)
            await wait('!!document.body && (location.pathname.includes("/reader/") || [...document.querySelectorAll("a")].some(a=>a.textContent.includes("Start Reading")))', source, timeout=60)
            await evaluate(source, '(()=>{if(!location.pathname.includes("/reader/")){[...document.querySelectorAll("a")].find(a=>a.textContent.includes("Start Reading")).click();}return true;})()')
            await wait('[...document.images].some(i=>i.src.includes("img.batcave.biz/img/")&&i.naturalWidth>0)', source, timeout=60)
            report["measurements"]["read_to_first_image_ms"] = round((time.monotonic()-start)*1000)
            report["checks"]["source_has_no_native_bridge"] = await evaluate(source, 'typeof window.Capacitor === "undefined"')
            selected = await evaluate(source, '(()=>{const o=[...document.querySelectorAll("select option")].find(o=>o.textContent.trim().startsWith("Page 3 /"));if(!o)return false;o.parentElement.value=o.value;o.parentElement.dispatchEvent(new Event("change",{bubbles:true}));return o.textContent.trim();})()')
            if not selected:
                raise RuntimeError("Source page selector not found")
            await asyncio.sleep(3)
            await screenshot(folder, "05-source-page-3")
            await close_source()
            history = await wait('(()=>{const h=JSON.parse(localStorage.getItem("comix.reading-history.v1")||"[]");return h.find(s=>s.title==="Adventure Time validation"&&s.reader==="source");})()')
            report["checks"]["history_page_3"] = history.get("page") == 2
            previous_target = source.ws_url.rsplit("/", 1)[-1]
            await source.close()
            await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Continue reading in app")&&!b.disabled)')
            await evaluate(app, '[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Continue reading in app")).click()')
            for _ in range(120):
                next_target = next((t for t in targets() if urllib.parse.urlparse(t["url"]).hostname == "batcave.biz" and t.get("type") == "page" and t["id"] != previous_target and t.get("title")), None)
                if next_target: break
                await asyncio.sleep(.25)
            else: raise RuntimeError("The resumed source WebView did not appear")
            source = await CDPConnection(next_target["webSocketDebuggerUrl"]).connect()
            await wait('[...document.querySelectorAll("select option:checked")].some(o=>o.textContent.trim().startsWith("Page 3 /"))', source, timeout=60)
            report["checks"]["source_page_restored"] = True
            await screenshot(folder, "06-source-resumed")
            await close_source()
            await source.close()
        await navigate("/library", 'document.body.innerText.includes("Import files")')
        # A generated three-page test comic; no third-party comic data in the fixture.
        from PIL import Image, ImageDraw
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as z:
            for number in range(1,4):
                image=Image.new("RGB",(600,900),(30+number*30,50,90)); ImageDraw.Draw(image).text((30,60),f"ComixCenter offline validation - page {number}",fill="white")
                data=io.BytesIO(); image.save(data,format="PNG"); z.writestr(f"{number:03}.png", data.getvalue())
        payload=base64.b64encode(archive.getvalue()).decode()
        start=time.monotonic()
        await evaluate(app, f'(()=>{{const bytes=Uint8Array.from(atob({json.dumps(payload)}),c=>c.charCodeAt(0));const file=new File([bytes],"ComixCenter validation.cbz",{{type:"application/zip"}});const dt=new DataTransfer();dt.items.add(file);const input=document.querySelector("#upload");input.files=dt.files;input.dispatchEvent(new Event("change",{{bubbles:true}}));return true;}})()')
        await wait('!document.body.innerText.includes("Importing 1 of") && [...document.querySelectorAll("a")].some(a=>a.textContent.includes("ComixCenter validation.cbz"))')
        report["measurements"]["three_page_import_ms"]=round((time.monotonic()-start)*1000)
        href=await evaluate(app, 'document.querySelector("a[aria-label=\\"Read ComixCenter validation.cbz\\"]").getAttribute("href")')
        adb("shell", "svc", "wifi", "disable"); adb("shell", "svc", "data", "disable")
        start=time.monotonic()
        await navigate(href, '!!document.querySelector(".reader-slider") && [...document.querySelectorAll("img.reader-page")].some(i=>i.naturalWidth>0)')
        report["measurements"]["offline_reader_image_ms"]=round((time.monotonic()-start)*1000)
        report["checks"]["offline_image_loaded"] = True
        await asyncio.sleep(1)
        await screenshot(folder,"07-offline-reader")
        adb("shell", "svc", "wifi", "enable"); adb("shell", "svc", "data", "enable")
        await navigate("/settings", 'document.body.innerText.includes("Save personal backup")')
        await evaluate(app,'[...document.querySelectorAll("button")].find(b=>b.textContent==="Save personal backup").click()')
        await asyncio.sleep(2)
        adb("shell", "input", "keyevent", "4")
        backup=await evaluate(app, '(async()=>{const date=new Date().toISOString().slice(0,10);const r=await window.Capacitor.nativePromise("Filesystem","readFile",{path:`backups/ComixCenter-backup-${date}.json`,directory:"CACHE",encoding:"utf8"});const b=JSON.parse(r.data);window.__smokeBackup=b;return {format:b.format,series:b.catalog.counts.series,library:b.library.length,hasAccounts:JSON.stringify(b).includes("credentials")};})()')
        report["checks"]["backup_written"] = backup
        await evaluate(app,'(()=>{const b=window.__smokeBackup;const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(b)],"validation-backup.json",{type:"application/json"}));const input=document.querySelector("input[aria-label=\\"Personal backup file\\"]");input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true;})()')
        await wait('document.body.innerText.includes("Review this restore")')
        await screenshot(folder,"08-backup-review")
        await evaluate(app,'[...document.querySelectorAll("button")].find(b=>b.textContent==="Replace catalog and restore").click()')
        await wait('document.body.innerText.includes("Restored.")')
        report["checks"]["backup_restored_via_ui"] = True
        await screenshot(folder,"09-backup-restored")
        for name,value in report["checks"].items():
            if value is False: report["failures"].append(name)
    except Exception as error:
        report["failures"].append(str(error))
        await screenshot(folder,"failure")
        raise
    finally:
        adb("shell", "svc", "wifi", "enable"); adb("shell", "svc", "data", "enable")
        await app.close()
        (folder/"report.json").write_text(json.dumps(report,indent=2))
        print(json.dumps(report,indent=2),flush=True)


if __name__ == "__main__": asyncio.run(main())
