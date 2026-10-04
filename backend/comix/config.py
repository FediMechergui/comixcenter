"""Runtime settings, read from environment variables and backend/.env."""
import os
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


def _default_data_dir() -> Path:
    # Outside OneDrive/Dropbox-style synced folders: syncing a live SQLite file can corrupt it.
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "ComixCenter"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "comixcenter"


def _env(name: str) -> Optional[str]:
    value = os.environ.get(name, "").strip()
    return value or None


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    database_url: str
    library_dir: Path
    cache_dir: Path
    scan_dirs: List[Path] = field(default_factory=list)
    metron_api_token: Optional[str] = None
    metron_username: Optional[str] = None
    metron_password: Optional[str] = None
    comicvine_api_key: Optional[str] = None
    admin_token: Optional[str] = None
    run_worker: bool = True
    user_agent: str = "ComixCenter/0.1"

    @property
    def metron_configured(self) -> bool:
        return bool(self.metron_api_token or (self.metron_username and self.metron_password))

    @property
    def comicvine_configured(self) -> bool:
        return bool(self.comicvine_api_key)


def load_settings() -> Settings:
    data_dir = Path(_env("COMIX_DATA_DIR") or _default_data_dir())
    scan_dirs = [Path(p.strip()) for p in (_env("COMIX_SCAN_DIRS") or "").split(";") if p.strip()]
    return Settings(
        data_dir=data_dir,
        database_url=_env("COMIX_DATABASE_URL") or f"sqlite:///{(data_dir / 'comix.db').as_posix()}",
        library_dir=data_dir / "library",
        cache_dir=data_dir / "cache",
        scan_dirs=scan_dirs,
        metron_api_token=_env("METRON_API_TOKEN"),
        metron_username=_env("METRON_USERNAME"),
        metron_password=_env("METRON_PASSWORD"),
        comicvine_api_key=_env("COMICVINE_API_KEY"),
        admin_token=_env("ADMIN_TOKEN"),
        run_worker=(_env("COMIX_RUN_WORKER") or "1") not in ("0", "false", "no"),
    )


@lru_cache
def get_settings() -> Settings:
    settings = load_settings()
    for path in (settings.data_dir, settings.library_dir, settings.cache_dir):
        path.mkdir(parents=True, exist_ok=True)
    return settings
