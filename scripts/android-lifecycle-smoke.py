"""Checks imported reader progress across background, rotation and process restart."""
import asyncio
import json
import runpy
import time
from pathlib import Path

base = runpy.run_path(str(Path(__file__).with_name("android-smoke.py")))
adb, evaluate, screenshot, targets, CDPConnection = [base[n] for n in ("adb", "evaluate", "screenshot", "targets", "CDPConnection")]


async def main():
    folder = Path("scratch/android-validation/lifecycle-0.3.0"); folder.mkdir(parents=True, exist_ok=True)
    report = {"checks": {}, "measurements": {}, "failures": []}
    app = await CDPConnection(next(t for t in targets() if t.get("type") == "page" and t["url"].startswith("http://localhost/"))["webSocketDebuggerUrl"]).connect()
    rotation = adb("shell", "settings", "get", "system", "user_rotation").decode().strip()
    automatic = adb("shell", "settings", "get", "system", "accelerometer_rotation").decode().strip()

    async def wait(expression, timeout=30):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                if await evaluate(app, expression): return
            except Exception: pass
            await asyncio.sleep(.25)
        raise RuntimeError("UI readiness timeout: " + expression[:100])

    async def navigate(path, ready):
        await evaluate(app, "window.__comixLeaving=true;location.href=" + json.dumps(path))
        await wait("!window.__comixLeaving && !!document.body && (" + ready + ")")

    try:
        await navigate("/library", '!!document.querySelector("a[aria-label=\\"Read ComixCenter validation.cbz\\"]")')
        href = await evaluate(app, 'document.querySelector("a[aria-label=\\"Read ComixCenter validation.cbz\\"]").getAttribute("href")')
        await navigate(href, '!!document.querySelector(".reader-slider") && [...document.images].some(i=>i.naturalWidth>0)')
        await evaluate(app, '(()=>{const r=document.querySelector(".reader-slider");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(r,"2");r.dispatchEvent(new Event("input",{bubbles:true}));r.dispatchEvent(new Event("change",{bubbles:true}));})()')
        await wait('document.querySelector(".reader-slider")?.value === "2"')
        await asyncio.sleep(1)
        adb("shell", "input", "keyevent", "3")
        adb("shell", "am", "start", "-n", "app.comixcenter/.MainActivity")
        await wait('document.querySelector(".reader-slider")?.value === "2"')
        report["checks"]["background_keeps_page_2"] = True
        adb("shell", "settings", "put", "system", "accelerometer_rotation", "0")
        adb("shell", "settings", "put", "system", "user_rotation", "1")
        await wait('innerWidth > innerHeight && document.querySelector(".reader-slider")?.value === "2"')
        await screenshot(folder,"10-reader-landscape")
        report["checks"]["rotation_keeps_page_2"] = True
        adb("shell", "settings", "put", "system", "user_rotation", "0")
        await app.close()
        adb("shell", "am", "force-stop", "app.comixcenter")
        adb("shell", "am", "start", "-n", "app.comixcenter/.MainActivity")
        for _ in range(80):
            try:
                pid=adb("shell", "pidof", "app.comixcenter").decode().strip()
                adb("forward", "tcp:9224", "localabstract:webview_devtools_remote_"+pid)
                target=next(t for t in targets() if t.get("type")=="page" and t["url"].startswith("http://localhost/"))
                app=await CDPConnection(target["webSocketDebuggerUrl"]).connect();break
            except Exception: await asyncio.sleep(.25)
        await wait('!!document.body && document.body.innerText.includes("Explore online comics")')
        await navigate(href, 'document.querySelector(".reader-slider")?.value === "2" && [...document.images].some(i=>i.naturalWidth>0)')
        report["checks"]["process_restart_keeps_page_2"] = True
        await screenshot(folder,"11-reader-after-restart")
        await app.send("Network.enable")
        await app.send("Network.emulateNetworkConditions", {"offline":False,"latency":300,"downloadThroughput":64000,"uploadThroughput":64000,"connectionType":"cellular3g"})
        report["measurements"]["throttled_gateway"] = await evaluate(app, '(async()=>{const t=performance.now();const r=await fetch("https://comixcenter-gateway.vercel.app/api/online/catalog?source=auto");const b=await r.json();return {ms:Math.round(performance.now()-t),status:r.status,entries:b.entries?.length||0};})()')
    except Exception as error:
        report["failures"].append(str(error)); await screenshot(folder,"failure"); raise
    finally:
        adb("shell", "settings", "put", "system", "user_rotation", rotation)
        adb("shell", "settings", "put", "system", "accelerometer_rotation", automatic)
        try: await app.send("Network.emulateNetworkConditions", {"offline":False,"latency":0,"downloadThroughput":-1,"uploadThroughput":-1})
        except Exception: pass
        await app.close();(folder/"report.json").write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)


if __name__ == "__main__": asyncio.run(main())
