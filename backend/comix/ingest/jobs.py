"""
Background sync jobs, stored in the database so they survive restarts.

Jobs are processed one at a time (Metron and Comic Vine both rate-limit per account).
A job that hits a daily rate limit is deferred until the limit resets instead of failing.
"""
import asyncio
import json
import logging
import traceback
from datetime import timedelta
from typing import Any, Callable, Dict, Optional

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from comix.db import session_scope
from comix.ingest import comicvine_sync, metron_sync
from comix.ingest.clients import NotConfiguredError, get_comicvine, get_metron
from comix.ingest.common import utcnow
from comix.models import Arc, CharacterEvent, CharacterEventKind, Identity, Issue, Job, JobStatus, Team

log = logging.getLogger("comix.jobs")

# Priorities: lower runs first
P_USER = 50        # something a person asked for
P_DETAIL = 110     # per-issue detail fetched after a series/arc sync
P_ENRICH = 150     # Comic Vine enrichment
P_DERIVE = 160     # local derivations


def _dedupe_key(kind: str, payload: Dict[str, Any]) -> str:
    return f"{kind}:{json.dumps(payload, sort_keys=True)}"[:300]


def enqueue(session: Session, kind: str, payload: Optional[Dict[str, Any]] = None,
            priority: int = P_USER) -> Job:
    """Queue a job unless an identical one is already waiting or running."""
    if kind not in HANDLERS:
        raise ValueError(f"Unknown job kind {kind!r}")
    payload = payload or {}
    key = _dedupe_key(kind, payload)
    existing = session.scalar(select(Job).where(
        Job.dedupe_key == key, Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING])))
    if existing is not None:
        if priority < existing.priority:
            existing.priority = priority
        return existing
    job = Job(kind=kind, payload=payload, dedupe_key=key, priority=priority)
    session.add(job)
    session.flush()
    return job


# ── Handlers ────────────────────────────────────────────────────────────────

class JobContext:
    def __init__(self, session: Session, job: Job):
        self.session = session
        self.job = job

    def progress(self, message: str) -> None:
        self.job.progress = message[:300]

    def enqueue(self, kind: str, payload: Dict[str, Any], priority: int) -> None:
        enqueue(self.session, kind, payload, priority)


def _after_issue_detail(ctx: JobContext, result: Dict[str, Any]) -> None:
    """New characters/teams get their full Metron record, then Comic Vine enrichment."""
    for identity_id in result.get("new_identity_ids", []):
        identity = ctx.session.get(Identity, identity_id)
        ctx.enqueue("metron.character", {"metron_id": identity.metron_id, "with_issues": False}, P_ENRICH)
    for team_id in result.get("new_team_ids", []):
        team = ctx.session.get(Team, team_id)
        ctx.enqueue("metron.team", {"metron_id": team.metron_id, "with_issues": False}, P_ENRICH)
    if ctx.session.get(Issue, result["issue_id"]).cv_id:
        ctx.enqueue("comicvine.issue", {"issue_id": result["issue_id"]}, P_ENRICH + 10)


def h_metron_publishers(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    return metron_sync.sync_publishers(ctx.session, get_metron(), ctx.progress)


def h_metron_series(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = metron_sync.sync_series(ctx.session, get_metron(), int(payload["metron_id"]), ctx.progress)
    if payload.get("deep", True):
        known = set(ctx.session.scalars(select(Issue.metron_id).where(
            Issue.metron_id.in_(result["issue_metron_ids"]), Issue.deep_synced_at.is_not(None))))
        for mid in result["issue_metron_ids"]:
            if mid not in known:
                ctx.enqueue("metron.issue", {"metron_id": mid}, P_DETAIL)
    ctx.enqueue("library.rematch", {}, P_DERIVE)
    result.pop("issue_metron_ids", None)
    return result


def h_metron_issue(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = metron_sync.sync_issue(ctx.session, get_metron(), int(payload["metron_id"]), ctx.progress)
    _after_issue_detail(ctx, result)
    return result


def h_metron_arc(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = metron_sync.sync_arc(ctx.session, get_metron(), int(payload["metron_id"]), ctx.progress)
    if payload.get("deep", True):
        for mid in result["issue_metron_ids"]:
            ctx.enqueue("metron.issue", {"metron_id": mid}, P_DETAIL)
    if ctx.session.get(Arc, result["arc_id"]).cv_id:
        ctx.enqueue("comicvine.arc", {"arc_id": result["arc_id"]}, P_ENRICH)
    result.pop("issue_metron_ids", None)
    return result


def h_metron_character(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = metron_sync.sync_character(ctx.session, get_metron(), int(payload["metron_id"]),
                                        with_issues=payload.get("with_issues", True), progress=ctx.progress)
    if ctx.session.get(Identity, result["identity_id"]).cv_id:
        ctx.enqueue("comicvine.identity", {"identity_id": result["identity_id"]}, P_ENRICH)
    return result


def h_metron_team(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = metron_sync.sync_team(ctx.session, get_metron(), int(payload["metron_id"]),
                                   with_issues=payload.get("with_issues", True), progress=ctx.progress)
    if ctx.session.get(Team, result["team_id"]).cv_id:
        ctx.enqueue("comicvine.team", {"team_id": result["team_id"]}, P_ENRICH)
    ctx.enqueue("teams.derive", {"team_id": result["team_id"]}, P_DERIVE)
    return result


def h_metron_reading_list(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    return metron_sync.sync_reading_list(ctx.session, get_metron(), int(payload["metron_id"]), ctx.progress)


def h_metron_find_series(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Look a series up by name (and year) and sync the best match; used when importing files."""
    from rapidfuzz import fuzz
    name, year = payload["name"], payload.get("year")
    candidates = metron_sync.search(get_metron(), "series", name, year) or (
        metron_sync.search(get_metron(), "series", name) if year else [])
    if not candidates:
        return {"found": False}

    def score(c: Dict[str, Any]) -> float:
        s = fuzz.token_sort_ratio(name, c["name"].split(" (")[0])
        if year and c.get("year_began"):
            s -= min(abs(int(year) - int(c["year_began"])), 10) * 3
        return s

    best = max(candidates, key=score)
    if score(best) < 70:
        return {"found": False, "closest": best["name"]}
    ctx.enqueue("metron.series", {"metron_id": best["metron_id"], "deep": bool(payload.get("deep", False))}, P_USER)
    return {"found": True, "metron_id": best["metron_id"], "name": best["name"]}


def h_comicvine_identity(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = comicvine_sync.enrich_identity(ctx.session, get_comicvine(), int(payload["identity_id"]))
    cv_first = result.get("first_appearance_cv_issue_id")
    identity = ctx.session.get(Identity, int(payload["identity_id"]))
    if cv_first and identity and identity.first_appearance_issue_id is None and payload.get("fetch_first", True):
        # Pull the first-appearance issue into the catalog so it links (Metron filters by cv_id)
        ctx.enqueue("metron.issue_by_cv", {"cv_id": cv_first}, P_ENRICH + 5)
    return result


def h_metron_issue_by_cv(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    matches = get_metron().issues_list({"cv_id": int(payload["cv_id"])})
    if not matches:
        return {"found": False}
    result = metron_sync.sync_issue(ctx.session, get_metron(), matches[0].id, ctx.progress)
    # Link first appearances / deaths recorded against this Comic Vine issue
    issue = ctx.session.get(Issue, result["issue_id"])
    for event in ctx.session.scalars(select(CharacterEvent).where(CharacterEvent.cv_issue_id == issue.cv_id)):
        event.issue_id = issue.id
    for identity in ctx.session.scalars(select(Identity).where(
            Identity.first_appearance_issue_id.is_(None),
            Identity.id.in_(select(CharacterEvent.identity_id).where(CharacterEvent.cv_issue_id == issue.cv_id,
                                                                     CharacterEvent.kind == CharacterEventKind.FIRST_APPEARANCE)))):
        identity.first_appearance_issue_id = issue.id
    return {"found": True, **result}


def h_comicvine_team(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = comicvine_sync.enrich_team(ctx.session, get_comicvine(), int(payload["team_id"]))
    ctx.enqueue("teams.derive", {"team_id": int(payload["team_id"])}, P_DERIVE)
    return result


def h_comicvine_arc(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    return comicvine_sync.enrich_arc(ctx.session, get_comicvine(), int(payload["arc_id"]))


def h_comicvine_issue(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    return comicvine_sync.enrich_issue(ctx.session, get_comicvine(), int(payload["issue_id"]))


def h_teams_derive(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    from comix.services.teams import derive_memberships
    return derive_memberships(ctx.session, int(payload["team_id"]))


def h_library_rematch(ctx: JobContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    from comix.library.matching import rematch_unmatched
    return rematch_unmatched(ctx.session, payload.get("file_ids"))


HANDLERS: Dict[str, Callable[[JobContext, Dict[str, Any]], Dict[str, Any]]] = {
    "metron.publishers": h_metron_publishers,
    "metron.series": h_metron_series,
    "metron.issue": h_metron_issue,
    "metron.issue_by_cv": h_metron_issue_by_cv,
    "metron.arc": h_metron_arc,
    "metron.character": h_metron_character,
    "metron.team": h_metron_team,
    "metron.reading_list": h_metron_reading_list,
    "metron.find_series": h_metron_find_series,
    "comicvine.identity": h_comicvine_identity,
    "comicvine.team": h_comicvine_team,
    "comicvine.arc": h_comicvine_arc,
    "comicvine.issue": h_comicvine_issue,
    "teams.derive": h_teams_derive,
    "library.rematch": h_library_rematch,
}


# ── Running ─────────────────────────────────────────────────────────────────

def _retry_after(exc: Exception) -> Optional[float]:
    """Seconds to wait when the exception is a rate-limit error from mokkari or simyan."""
    name = type(exc).__name__
    if name in ("RateLimitError",):
        return float(getattr(exc, "retry_after", 0) or 60)
    return None


def claim_next_job() -> Optional[int]:
    with session_scope() as session:
        now = utcnow()
        job = session.scalar(select(Job).where(
            Job.status == JobStatus.QUEUED, or_(Job.run_after.is_(None), Job.run_after <= now))
            .order_by(Job.priority, Job.id).limit(1))
        if job is None:
            return None
        claimed = session.execute(update(Job).where(Job.id == job.id, Job.status == JobStatus.QUEUED)
                                  .values(status=JobStatus.RUNNING, started_at=now, attempts=Job.attempts + 1)).rowcount
        return job.id if claimed else None


def run_job(job_id: int) -> JobStatus:
    """Runs one claimed job in its own transaction and records the outcome."""
    with session_scope() as session:
        job = session.get(Job, job_id)
        handler = HANDLERS[job.kind]
        ctx = JobContext(session, job)
        try:
            with session.begin_nested():
                result = handler(ctx, dict(job.payload or {}))
        except NotConfiguredError as exc:
            job.status, job.error, job.finished_at = JobStatus.FAILED, str(exc), utcnow()
            return job.status
        except Exception as exc:  # noqa: BLE001 - every failure is recorded on the job
            wait = _retry_after(exc)
            if wait is not None:
                job.status = JobStatus.QUEUED
                job.run_after = utcnow() + timedelta(seconds=wait)
                job.error = f"Rate limited; retrying after {int(wait)}s: {exc}"
                log.warning("job %s deferred %ss: %s", job.id, int(wait), exc)
                return job.status
            job.status, job.finished_at = JobStatus.FAILED, utcnow()
            job.error = f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=3)}"[:4000]
            log.warning("job %s (%s) failed: %s", job.id, job.kind, exc)
            return job.status
        job.status, job.result, job.error, job.finished_at = JobStatus.DONE, result, None, utcnow()
        return job.status


def requeue_interrupted() -> int:
    """Jobs left RUNNING by a crash or restart go back to the queue."""
    with session_scope() as session:
        return session.execute(update(Job).where(Job.status == JobStatus.RUNNING)
                               .values(status=JobStatus.QUEUED)).rowcount


def run_pending(limit: Optional[int] = None) -> int:
    """Synchronously run queued jobs (CLI and tests). Returns how many ran."""
    ran = 0
    while limit is None or ran < limit:
        job_id = claim_next_job()
        if job_id is None:
            break
        run_job(job_id)
        ran += 1
    return ran


class Worker:
    """Polls the queue inside the API process; runs blocking client calls in a thread."""

    def __init__(self, idle_seconds: float = 2.0):
        self.idle_seconds = idle_seconds
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self.current_job_id: Optional[int] = None

    async def _loop(self) -> None:
        await asyncio.to_thread(requeue_interrupted)
        while not self._stop.is_set():
            try:
                job_id = await asyncio.to_thread(claim_next_job)
                if job_id is None:
                    try:
                        await asyncio.wait_for(self._stop.wait(), self.idle_seconds)
                    except asyncio.TimeoutError:
                        pass
                    continue
                self.current_job_id = job_id
                await asyncio.to_thread(run_job, job_id)
            except Exception:  # noqa: BLE001 - keep the worker alive
                log.exception("worker loop error")
                await asyncio.sleep(self.idle_seconds)
            finally:
                self.current_job_id = None

    def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="comix-job-worker")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await self._task

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()
