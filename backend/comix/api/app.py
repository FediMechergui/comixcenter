"""FastAPI application: API routers, the background sync worker, and the bundled web app."""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from comix import __version__
from comix.api.routers import admin, library, public
from comix.bootstrap import bootstrap
from comix.config import BACKEND_DIR, get_settings
from comix.db import get_db, session_scope, upgrade_database
from comix.ingest.jobs import Worker
from comix.network import lan_addresses
from comix.models import Arc, Character, Issue, Job, JobStatus, LibraryFile, ReadingOrder, Series, Team

log = logging.getLogger("comix")
WEB_DIR = BACKEND_DIR.parent / "web" / "out"


def create_app(run_migrations: bool = True, start_worker: bool = None) -> FastAPI:
    settings = get_settings()
    worker = Worker()
    start_worker = settings.run_worker if start_worker is None else start_worker

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if run_migrations:
            upgrade_database()
        with session_scope() as session:
            bootstrap(session)
        if start_worker:
            worker.start()
        yield
        if start_worker:
            await worker.stop()

    app = FastAPI(title="ComixCenter", version=__version__, lifespan=lifespan,
                  description="Comic catalog, reading orders, characters and teams, and your own library.")
    # A local, token-less API: any origin may read it (the PWA, the Android app, dev servers)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["Content-Disposition"])
    app.state.worker = worker

    app.include_router(public.router)
    app.include_router(library.router)
    app.include_router(library.opds_router)
    app.include_router(admin.router)

    @app.get("/api/status", tags=["system"])
    def status(request: Request, db: Session = Depends(get_db)):
        count = lambda model: db.scalar(select(func.count()).select_from(model))
        jobs = dict(db.execute(select(Job.status, func.count()).group_by(Job.status)).all())
        return {
            "version": __version__,
            "sources": {"metron": settings.metron_configured, "comicvine": settings.comicvine_configured},
            "admin_protected": bool(settings.admin_token),
            "worker": {"running": worker.running, "current_job_id": worker.current_job_id,
                       "queued": jobs.get(JobStatus.QUEUED, 0), "failed": jobs.get(JobStatus.FAILED, 0)},
            "counts": {"series": count(Series), "issues": count(Issue), "arcs": count(Arc), "characters": count(Character),
                       "teams": count(Team), "reading_orders": count(ReadingOrder), "library_files": count(LibraryFile)},
            "scan_dirs": [str(p) for p in settings.scan_dirs],
            # Addresses a phone on the same Wi-Fi can use (the server must listen with --lan)
            "lan_urls": [f"http://{ip}:{request.url.port or 8000}" for ip in lan_addresses()],
        }

    if WEB_DIR.is_dir():
        # The static Next.js export: real files first, then <route>.html, then the app shell
        app.mount("/_next", StaticFiles(directory=WEB_DIR / "_next"), name="next-assets")

        @app.get("/{path:path}", include_in_schema=False)
        def web(path: str):
            candidate = (WEB_DIR / path).resolve()
            if WEB_DIR.resolve() in candidate.parents or candidate == WEB_DIR.resolve():
                if candidate.is_file():
                    return FileResponse(candidate)
                if candidate.with_suffix(".html").is_file():
                    return FileResponse(candidate.with_suffix(".html"))
                if (candidate / "index.html").is_file():
                    return FileResponse(candidate / "index.html")
            return FileResponse(WEB_DIR / "index.html")

    return app
