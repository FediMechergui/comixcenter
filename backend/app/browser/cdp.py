"""
Minimal Chrome DevTools Protocol driver for a real, locally installed Chrome.

Why a real browser: Cloudflare's cf_clearance cookie is bound to the browser that
earned it (IP, User-Agent and TLS fingerprint). Copying it into an HTTP client is
unreliable, so protected providers send their requests *through* this browser
instead (same-origin fetch() inside a page on the protected site).

Deliberately avoided: Runtime.enable and automation flags (--enable-automation,
headless). The browser is an ordinary Chrome window; when Cloudflare asks for a
human check, the user completes it themselves in that window.
"""
import asyncio
import json
import os
import shutil
import subprocess
import time
from typing import Any, Dict, List, Optional

import httpx
from websockets.asyncio.client import connect, ClientConnection

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]
CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"]


class CDPError(RuntimeError):
    pass


def find_chrome(explicit: Optional[str] = None) -> str:
    """Chrome/Edge executable: explicit path, $COMIX_CHROME_PATH, known install paths, then $PATH."""
    for path in (explicit, os.environ.get("COMIX_CHROME_PATH")):
        if path and os.path.isfile(path):
            return path
    for path in CHROME_CANDIDATES:
        if os.path.isfile(path):
            return path
    for name in CHROME_NAMES:
        found = shutil.which(name)
        if found:
            return found
    raise FileNotFoundError("Chrome or Edge not found. Set COMIX_CHROME_PATH to the browser executable.")


class CDPConnection:
    """One websocket session to a DevTools target, with request/response matching by id."""

    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        self._ws: Optional[ClientConnection] = None
        self._next_id = 0
        self._pending: Dict[int, asyncio.Future] = {}
        self._reader: Optional[asyncio.Task] = None

    async def connect(self) -> "CDPConnection":
        self._ws = await connect(self.ws_url, max_size=None, ping_interval=None)
        self._reader = asyncio.create_task(self._read_loop())
        return self

    @property
    def closed(self) -> bool:
        return self._ws is None or self._reader is None or self._reader.done()

    async def send(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 30.0) -> Dict[str, Any]:
        if self.closed:
            raise CDPError("DevTools connection is closed")
        self._next_id += 1
        msg_id = self._next_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        await self._ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    async def _read_loop(self):
        try:
            async for raw in self._ws:
                data = json.loads(raw)
                fut = self._pending.get(data.get("id"))
                if fut is None or fut.done():
                    continue  # events are ignored; we only use request/response
                if "error" in data:
                    fut.set_exception(CDPError(data["error"].get("message", str(data["error"]))))
                else:
                    fut.set_result(data.get("result", {}))
        except Exception:
            pass
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(CDPError("DevTools connection lost"))

    async def close(self):
        if self._ws is not None:
            await self._ws.close()
        if self._reader is not None:
            await asyncio.gather(self._reader, return_exceptions=True)


class ChromeBrowser:
    """
    A visible Chrome window with its own profile directory, controlled over a
    localhost-only DevTools port. Reuses an already running instance on that port,
    so a backend restart doesn't lose the Cloudflare session.
    """

    def __init__(self, profile_dir: str, port: int = 9333, chrome_path: Optional[str] = None,
                 window_size: str = "1100,820"):
        self.profile_dir = os.path.abspath(profile_dir)
        self.port = port
        self.chrome_path = chrome_path
        self.window_size = window_size
        self._process: Optional[subprocess.Popen] = None
        self._page: Optional[CDPConnection] = None
        self._lock = asyncio.Lock()

    @property
    def devtools_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def is_running(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.5) as client:
                return (await client.get(f"{self.devtools_url}/json/version")).status_code == 200
        except httpx.HTTPError:
            return False

    async def start(self, start_url: str = "about:blank", timeout: float = 20.0):
        async with self._lock:
            if await self.is_running():
                return
            os.makedirs(self.profile_dir, exist_ok=True)
            args = [
                find_chrome(self.chrome_path),
                f"--remote-debugging-port={self.port}",
                f"--user-data-dir={self.profile_dir}",
                "--no-first-run",
                "--no-default-browser-check",
                f"--window-size={self.window_size}",
                start_url,
            ]
            self._process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if await self.is_running():
                    return
                if self._process.poll() is not None:
                    raise CDPError(f"Chrome exited during startup (code {self._process.returncode})")
                await asyncio.sleep(0.3)
            raise CDPError("Chrome DevTools endpoint did not come up in time")

    async def page(self) -> CDPConnection:
        """Connection to the first open tab, creating one if the window has none."""
        if self._page is not None and not self._page.closed:
            return self._page
        async with httpx.AsyncClient(timeout=5.0) as client:
            targets: List[Dict[str, Any]] = (await client.get(f"{self.devtools_url}/json/list")).json()
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if not pages:
                pages = [(await client.put(f"{self.devtools_url}/json/new?about:blank")).json()]
        self._page = await CDPConnection(pages[0]["webSocketDebuggerUrl"]).connect()
        return self._page

    async def evaluate(self, expression: str, timeout: float = 30.0) -> Any:
        """Evaluates JS in the tab (awaiting promises) and returns the JSON-serialisable result."""
        page = await self.page()
        result = await page.send("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        }, timeout=timeout)
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            text = details.get("exception", {}).get("description") or details.get("text", "JS exception")
            raise CDPError(text)
        return result.get("result", {}).get("value")

    async def navigate(self, url: str):
        await (await self.page()).send("Page.navigate", {"url": url})

    async def navigate_and_wait(self, url: str, timeout: float = 10.0):
        await self.navigate(url)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = await self.current_url()
            state = await self.evaluate("document.readyState")
            if current == url and state in ("interactive", "complete"):
                return
            await asyncio.sleep(0.5)
        # It might have redirected, just check if we are on the right domain
        
    async def ensure_origin(self, origin: str, timeout: float = 20.0):
        """Ensures the tab is on the given origin and fully loaded (e.g. past Cloudflare)."""
        current = await self.current_url()
        if not current.startswith(origin):
            await self.navigate(origin)
            
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = await self.current_url()
            state = await self.evaluate("document.readyState")
            if current.startswith(origin) and state in ("interactive", "complete"):
                title = await self.evaluate("document.title")
                if title and "Just a moment" not in title:
                    return
            await asyncio.sleep(0.5)
        raise CDPError(f"Timeout waiting for origin {origin} and CF challenge to clear.")

    async def current_url(self) -> str:
        return await self.evaluate("location.href") or ""

    async def cookies(self, url: str) -> List[Dict[str, Any]]:
        result = await (await self.page()).send("Network.getCookies", {"urls": [url]})
        return result.get("cookies", [])

    async def user_agent(self) -> str:
        return await self.evaluate("navigator.userAgent") or ""

    async def bring_to_front(self):
        await (await self.page()).send("Page.bringToFront")

    async def close(self):
        if self._page is not None:
            await self._page.close()
            self._page = None
        if self._process is not None and self._process.poll() is None:
            self._process.terminate()
            try:
                await asyncio.to_thread(self._process.wait, timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                await asyncio.to_thread(self._process.wait, timeout=5)
            self._process = None
