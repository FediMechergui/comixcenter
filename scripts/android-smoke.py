"""Measure the installed APK and capture screenshots on the Android emulator."""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app.browser.cdp import CDPConnection

SDK = Path(os.environ.get("ANDROID_HOME", Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk"))
ADB = str(SDK / "platform-tools/adb.exe")


def adb(*args):
    return subprocess.check_output([ADB, "-s", "emulator-5554", *args], timeout=15)


def targets():
    return json.load(urllib.request.urlopen("http://127.0.0.1:9224/json/list", timeout=5))


async def evaluate(connection, expression):
    result = await connection.send("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in result:
        raise RuntimeError(str(result["exceptionDetails"]))
    return result["result"].get("value")


async def screenshot(folder, name):
    (folder / (name + ".png")).write_bytes(await asyncio.to_thread(adb, "exec-out", "screencap", "-p"))


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="smoke")
    args = parser.parse_args()
    folder = Path("scratch/android-validation") / args.label
    folder.mkdir(parents=True, exist_ok=True)
    devices = subprocess.check_output([ADB, "devices"], text=True)
    if "emulator-5554\tdevice" not in devices:
        subprocess.Popen([str(SDK / "emulator/emulator.exe"), "-avd", "Cartoony_Release_Test_API35", "-no-window", "-no-audio", "-no-snapshot-save"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                if adb("shell", "getprop", "sys.boot_completed").strip() == b"1":
                    break
            except (subprocess.SubprocessError, OSError):
                pass
            await asyncio.sleep(1)
        else:
            raise RuntimeError("Emulator did not boot")
    adb("shell", "am", "force-stop", "app.comixcenter")
    start = time.monotonic()
    adb("shell", "am", "start", "-n", "app.comixcenter/.MainActivity")
    connection = None
    for _ in range(40):
        try:
            pid = adb("shell", "pidof", "app.comixcenter").decode().strip()
            adb("forward", "tcp:9224", "localabstract:webview_devtools_remote_" + pid)
            target = next(t for t in targets() if "localhost" in t["url"])
            connection = await CDPConnection(target["webSocketDebuggerUrl"]).connect()
            break
        except Exception:
            await asyncio.sleep(.25)
    if connection is None:
        raise RuntimeError("App WebView not available")
    report = {"label": args.label, "device": adb("shell", "getprop", "ro.product.model").decode().strip(), "measurements": {}, "failures": []}

    async def wait(expression, seconds=25):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                if await evaluate(connection, '!!document.body && (' + expression + ')'):
                    return
            except RuntimeError:
                pass  # A document or execution context may be replaced during navigation.
            await asyncio.sleep(.2)
        raise RuntimeError("Timed out waiting for UI")

    try:
        await wait('document.body.innerText.includes("Explore online comics")')
        report["measurements"]["launch_to_discover_ms"] = round((time.monotonic() - start) * 1000)
        report["navigation_timing"] = await evaluate(connection, '(()=>{const n=performance.getEntriesByType("navigation")[0];return n?{dom_content_loaded_ms:Math.round(n.domContentLoadedEventEnd),load_ms:Math.round(n.loadEventEnd)}:null;})()')
        try:
            await wait('document.querySelectorAll("#latest .list-row, #latest .discovery-book").length > 0')
            report["measurements"]["launch_to_online_rows_ms"] = round((time.monotonic() - start) * 1000)
        except RuntimeError:
            report["failures"].append("Online catalog did not show entries")
        await screenshot(folder, "01-discover")
        routes = [("02-library", "/library", 'document.body.innerText.includes("Import files")'), ("03-guides", "/guides", 'document.querySelectorAll(".guide-card").length > 0 || document.body.innerText.includes("12")'), ("04-settings", "/settings", 'document.body.innerText.includes("About")')]
        for name, path, ready in routes:
            start = time.monotonic()
            await evaluate(connection, f"window.__comixLeaving=true;location.href={json.dumps(path)}")
            await wait('!window.__comixLeaving && location.pathname === ' + json.dumps(path) + ' && (' + ready + ')')
            report["measurements"][name + "_ready_ms"] = round((time.monotonic() - start) * 1000)
            await screenshot(folder, name)
        report["gateway"] = await evaluate(connection, """(async()=>{const result=[];for(let i=0;i<3;i++){const t=performance.now();try{const r=await fetch('https://comixcenter-gateway.vercel.app/api/online/catalog?source=auto');const d=await r.json();result.push({ms:Math.round(performance.now()-t),status:r.status,entries:d.entries?.length||0,source:d.source});}catch(e){result.push({error:e.message});}}return result;})()""")
    finally:
        await connection.close()
        (folder / "report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2), flush=True)
    if report["failures"]:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
