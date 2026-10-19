"""Exercise native download progress/cancel/retry/failures through the installed APK's OPDS UI.

Only generated comic bytes and temporary loopback HTTP servers are used.
Run android-smoke.py first to start/attach the emulator and establish DevTools forwarding.
"""
import asyncio
import argparse
import io
import json
import random
import runpy
import threading
import time
import urllib.parse
import zipfile
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from PIL import Image, ImageDraw

base = runpy.run_path(str(Path(__file__).with_name("android-smoke.py")))
adb, evaluate, screenshot, targets, CDPConnection = [base[n] for n in ("adb", "evaluate", "screenshot", "targets", "CDPConnection")]


def fixture():
    archive = io.BytesIO(); rng = random.Random(42)
    with zipfile.ZipFile(archive, "w") as z:
        for number in range(1,4):
            image = Image.frombytes("RGB", (600,900), rng.randbytes(600*900*3))
            ImageDraw.Draw(image).rectangle((10,10,590,90), fill="black")
            ImageDraw.Draw(image).text((25,30), f"Download validation - page {number}", fill="white")
            page=io.BytesIO(); image.save(page,format="PNG"); z.writestr(f"{number}.png",page.getvalue())
    return archive.getvalue()


async def main():
    parser=argparse.ArgumentParser();parser.add_argument("--label",default="downloads-current");args=parser.parse_args()
    folder=Path("scratch/android-validation")/args.label; folder.mkdir(parents=True,exist_ok=True)
    payload=fixture(); counts=Counter(); observations=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            path=urllib.parse.urlparse(self.path).path; counts[path]+=1
            observations.append({"path":path,"port":self.server.server_port,"authorization":bool(self.headers.get("Authorization")),"range":bool(self.headers.get("Range"))})
            try:
                if path=="/catalog":
                    rows=[("QA slow cancel", "slow"),("QA oversized header","large"),("QA oversized stream","unknown-large"),("QA verification page","html"),("QA broken connection","broken"),("QA stalled connection","stall"),("QA cross origin","redirect"),("QA process interruption","restart")]
                    entries="".join(f'<entry><id>{slug}</id><title>{title}</title><link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="http://10.0.2.2:{primary.server_port}/{slug}"/></entry>' for title,slug in rows)
                    body=('<feed xmlns="http://www.w3.org/2005/Atom"><id>qa</id><title>Download validation</title>'+entries+'</feed>').encode()
                    self.send_response(200);self.send_header("Content-Type","application/atom+xml");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body);return
                if path=="/redirect":
                    self.send_response(302);self.send_header("Location",f"http://10.0.2.2:{secondary.server_port}/cross-file");self.end_headers();return
                self.send_response(200)
                self.send_header("Content-Type","text/html" if path=="/html" else "application/octet-stream")
                if path=="/large":self.send_header("Content-Length",str(65*1024*1024))
                elif path!="/unknown-large":self.send_header("Content-Length",str(12 if path=="/html" else len(payload)))
                self.end_headers()
                if path=="/large":return
                if path=="/html":self.wfile.write(b"Verification");return
                if path=="/unknown-large":
                    chunk=bytes(1024*1024)
                    for _ in range(65):self.wfile.write(chunk)
                    return
                if path=="/broken":self.wfile.write(payload[:16384]);self.wfile.flush();self.close_connection=True;return
                if path=="/stall":time.sleep(12);return
                delay=.06 if path in ("/slow","/restart") and counts[path]==1 else .003
                for offset in range(0,len(payload),32768):
                    self.wfile.write(payload[offset:offset+32768]);self.wfile.flush();time.sleep(delay)
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError): pass
    primary=ThreadingHTTPServer(("127.0.0.1",0),Handler);secondary=ThreadingHTTPServer(("127.0.0.1",0),Handler)
    for server in (primary,secondary):threading.Thread(target=server.serve_forever,daemon=True).start()
    name=f"Download QA {primary.server_port}"
    report={"checks":{},"measurements":{},"failures":[],"fixture_bytes":len(payload)}
    app=await CDPConnection(next(t for t in targets() if t.get("type")=="page" and urllib.parse.urlparse(t["url"]).hostname=="localhost")["webSocketDebuggerUrl"]).connect()

    async def wait(js,timeout=150):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                value=await evaluate(app,js)
                if value:return value
            except Exception:pass
            await asyncio.sleep(.2)
        raise RuntimeError("UI timeout: "+js[:120])
    async def navigate(path,ready):
        await evaluate(app,"window.__comixLeaving=true;location.href="+json.dumps(path))
        await wait("!window.__comixLeaving && !!document.body && ("+ready+")")
    async def click(js): await evaluate(app,js+".click()")
    async def open_feed():
        await navigate("/opds",f'[...document.querySelectorAll("button.body")].some(b=>b.textContent.includes({json.dumps(name)}))')
        await click(f'[...document.querySelectorAll("button.body")].find(b=>b.textContent.includes({json.dumps(name)}))')
        await wait('[...document.querySelectorAll(".list-row")].some(r=>r.querySelector("strong")?.textContent==="QA slow cancel" && [...r.querySelectorAll("button")].some(b=>b.textContent.includes("Save")))')
    async def start(title):
        await open_feed()
        await click(f'[...document.querySelectorAll(".list-row")].find(r=>r.textContent.includes({json.dumps(title)})).querySelector("button")')
    async def latest(phase):
        result=await wait(f'(()=>{{const h=JSON.parse(localStorage.getItem("comix.downloads.v1")||"[]");return h[0]&&["failed",{json.dumps(phase)}].includes(h[0].phase)?h[0]:false;}})()')
        if result["phase"]!=phase:raise RuntimeError(result.get("error","The download failed"))
        return result
    async def cache_empty():
        return await wait('(async()=>{try{const r=await window.Capacitor.nativePromise("Filesystem","readdir",{path:"comic-downloads",directory:"CACHE"});return r.files.length===0;}catch(e){return false;}})()')
    try:
        await navigate("/opds",'!!document.querySelector("input[placeholder=\\"My Komga\\"]") && !!document.querySelector("button.body")')
        values=[name,f"http://10.0.2.2:{primary.server_port}/catalog","qa-user","qa-password"]
        for index,value in enumerate(values):
            await evaluate(app,f'(()=>{{const input=document.querySelectorAll("form input")[{index}];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,{json.dumps(value)});input.dispatchEvent(new Event("input",{{bubbles:true}}));return true;}})()')
            await asyncio.sleep(.1)
        await evaluate(app,'document.querySelector("form").requestSubmit()')
        await wait(f'[...document.querySelectorAll("button.body")].some(b=>b.textContent.includes({json.dumps(name)}))')
        await start("QA slow cancel")
        await wait('(()=>{const m=document.querySelector(".download-notice")?.textContent.match(/([\\d.]+) (KB|MB)/);return m&&Number(m[1])>0;})()')
        await wait('(async()=>{const r=await window.Capacitor.nativePromise("Filesystem","readdir",{path:"comic-downloads",directory:"CACHE"});return r.files.some(f=>f.name.endsWith(".part"));})()')
        report["checks"]["partial_file_existed_before_cancel"]=True
        await click('document.querySelector(".download-notice a")')
        await wait('!!document.querySelector(".download-job[data-phase=downloading]")')
        report["checks"]["progress_survives_client_navigation"]=True
        await asyncio.sleep(.3); await screenshot(folder,"01-downloading")
        start_time=time.monotonic();await click('document.querySelector(".download-job[data-phase=downloading] button")')
        await latest("cancelled");await cache_empty()
        report["measurements"]["cancel_to_clean_ms"]=round((time.monotonic()-start_time)*1000)
        report["checks"]["cancel_removes_partial_file"]=True
        await navigate("/library",'!!document.querySelector(".download-job[data-phase=cancelled]")')
        await screenshot(folder,"02-cancelled")
        start_time=time.monotonic();await click('[...document.querySelectorAll(".download-job")].find(r=>r.textContent.includes("QA slow cancel")).querySelector("button")')
        job=await latest("saved");await cache_empty()
        report["measurements"]["retry_to_saved_ms"]=round((time.monotonic()-start_time)*1000)
        report["checks"]["retry_imported_comic"]=bool(job.get("fileId"))
        await screenshot(folder,"03-saved")
        await navigate(f'/read?file={job["fileId"]}','!!document.querySelector(".reader-slider") && [...document.querySelectorAll("img.reader-page")].some(i=>i.naturalWidth>0)')
        await asyncio.sleep(.5);await screenshot(folder,"04-downloaded-reader")
        for title,fragment in [("QA oversized header","64 MB"),("QA oversized stream","64 MB"),("QA verification page","web page"),("QA broken connection","interrupted"),("QA stalled connection","interrupted")]:
            start_time=time.monotonic();await start(title);failed=await latest("failed");await cache_empty()
            if title=="QA stalled connection":report["measurements"]["stalled_source_to_failure_ms"]=round((time.monotonic()-start_time)*1000)
            if fragment.lower() not in failed.get("error","").lower():raise RuntimeError(f"Unexpected failure for {title}: {failed.get('error')}")
            report["checks"][title]=True
        await navigate("/library",'!!document.querySelector(".download-job[data-phase=failed]") && document.body.innerText.includes("QA stalled connection")');await screenshot(folder,"05-source-errors")
        await start("QA cross origin");await latest("saved");await cache_empty()
        first=next(o for o in observations if o["path"]=="/redirect")
        crossed=next(o for o in observations if o["path"]=="/cross-file")
        report["checks"]["source_authentication_sent"]=first["authorization"]
        report["checks"]["redirect_drops_authentication"]=not crossed["authorization"]
        await start("QA process interruption");await wait('(()=>{const m=document.querySelector(".download-notice")?.textContent.match(/([\\d.]+) (KB|MB)/);return m&&Number(m[1])>0;})()')
        adb("shell","am","force-stop","app.comixcenter");await app.close()
        adb("shell","am","start","-n","app.comixcenter/.MainActivity")
        for _ in range(80):
            try:
                pid=adb("shell","pidof","app.comixcenter").decode().strip();adb("forward","tcp:9224","localabstract:webview_devtools_remote_"+pid)
                target=next(t for t in targets() if t.get("type")=="page" and urllib.parse.urlparse(t["url"]).hostname=="localhost")
                app=await CDPConnection(target["webSocketDebuggerUrl"]).connect();break
            except Exception:await asyncio.sleep(.25)
        await wait('!!document.body && document.body.innerText.includes("Explore online comics")')
        await navigate("/library",'!!document.querySelector(".download-job[data-phase=interrupted]")')
        await cache_empty();await screenshot(folder,"06-interrupted-recovered")
        report["checks"]["process_death_marks_interrupted_and_cleans_cache"]=True
        await click('[...document.querySelectorAll(".download-job")].find(r=>r.textContent.includes("QA process interruption")).querySelector("button")')
        await latest("saved");await cache_empty()
        report["checks"]["interrupted_transfer_can_retry"]=True
        report["checks"]["retry_restarts_without_range"]=not any(o["range"] for o in observations if o["path"] in ("/slow","/restart"))
        if not all(report["checks"].values()):raise RuntimeError("A download check failed")
    except Exception as error:
        report["failures"].append(str(error));await screenshot(folder,"failure");raise
    finally:
        await app.close();primary.shutdown();secondary.shutdown()
        (folder/"report.json").write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)


if __name__=="__main__":asyncio.run(main())
