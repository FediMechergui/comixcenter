"""Engine, sessions and the full-text search index."""
from contextlib import contextmanager
from typing import Iterator, Optional

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from comix.config import get_settings

# Search index rows use rowid = ref_id * 16 + kind code, so triggers can update one row by rowid.
SEARCH_KINDS = {"series": 1, "issue": 2, "arc": 3, "character": 4, "identity": 5,
                "team": 6, "creator": 7, "order": 8}

_ISSUE_TITLE = ("(SELECT name FROM series WHERE id = NEW.series_id) || ' #' || NEW.number"
                " || COALESCE(' ' || NEW.title, '')")

_INDEXED = {
    # kind: (table, title expression, body expression)
    "series": ("series", "NEW.name || COALESCE(' (' || NEW.year_began || ')', '')",
               "COALESCE(NEW.description, '')"),
    "issue": ("issues", _ISSUE_TITLE, "COALESCE(NEW.description, '')"),
    "arc": ("arcs", "NEW.name", "COALESCE(NEW.description, '')"),
    "character": ("characters", "NEW.name", "COALESCE(NEW.description, '')"),
    "identity": ("identities",
                 "NEW.display_name || CASE WHEN NEW.name != NEW.display_name THEN ' ' || NEW.name ELSE '' END",
                 "COALESCE(NEW.real_name, '') || ' ' || COALESCE(NEW.aliases, '') || ' ' || COALESCE(NEW.description, '')"),
    "team": ("teams", "NEW.name", "COALESCE(NEW.description, '')"),
    "creator": ("creators", "NEW.name", "''"),
    "order": ("reading_orders", "NEW.name", "COALESCE(NEW.description, '')"),
}


def search_index_ddl() -> list[str]:
    """FTS5 table plus insert/update/delete triggers for every searchable table."""
    statements = [
        "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5("
        "kind UNINDEXED, ref_id UNINDEXED, title, body, "
        "tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3 4')",
    ]
    for kind, (table, title, body) in _INDEXED.items():
        code = SEARCH_KINDS[kind]
        upsert = (f"INSERT OR REPLACE INTO search_index(rowid, kind, ref_id, title, body) "
                  f"VALUES (NEW.id * 16 + {code}, '{kind}', NEW.id, {title}, {body});")
        statements += [
            f"CREATE TRIGGER IF NOT EXISTS {table}_ai AFTER INSERT ON {table} BEGIN {upsert} END",
            f"CREATE TRIGGER IF NOT EXISTS {table}_au AFTER UPDATE ON {table} BEGIN {upsert} END",
            f"CREATE TRIGGER IF NOT EXISTS {table}_ad AFTER DELETE ON {table} BEGIN "
            f"DELETE FROM search_index WHERE rowid = OLD.id * 16 + {code}; END",
        ]
    # Renaming a series changes its issues' titles
    statements.append(
        "CREATE TRIGGER IF NOT EXISTS series_au_issues AFTER UPDATE OF name ON series BEGIN "
        "UPDATE issues SET number = number WHERE series_id = NEW.id; END")
    return statements


def drop_search_index_ddl() -> list[str]:
    statements = ["DROP TRIGGER IF EXISTS series_au_issues"]
    for _, (table, _, _) in _INDEXED.items():
        statements += [f"DROP TRIGGER IF EXISTS {table}_{s}" for s in ("ai", "au", "ad")]
    statements.append("DROP TABLE IF EXISTS search_index")
    return statements


def make_engine(url: str) -> Engine:
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30}
                           if url.startswith("sqlite") else {})
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):
            # Let SQLAlchemy own transactions so SAVEPOINTs (begin_nested) work with pysqlite
            dbapi_conn.isolation_level = None
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys = ON")
            cur.execute("PRAGMA journal_mode = WAL")
            cur.execute("PRAGMA synchronous = NORMAL")
            cur.execute("PRAGMA busy_timeout = 30000")
            cur.close()

        @event.listens_for(engine, "begin")
        def _sqlite_begin(conn):
            conn.exec_driver_sql("BEGIN")
    return engine


_engine: Optional[Engine] = None
_session_factory: Optional[sessionmaker] = None


def configure(url: Optional[str] = None) -> Engine:
    """(Re)bind the module to a database; tests call this with a temporary file."""
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = make_engine(url or get_settings().database_url)
    _session_factory = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def get_engine() -> Engine:
    return _engine or configure()


def new_session() -> Session:
    if _session_factory is None:
        configure()
    return _session_factory()


@contextmanager
def session_scope() -> Iterator[Session]:
    session = new_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Iterator[Session]:
    """FastAPI dependency."""
    session = new_session()
    try:
        yield session
    finally:
        session.close()


def create_schema(engine: Engine) -> None:
    """Create tables and the search index directly (tests); production uses migrations."""
    from comix.models import Base
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for stmt in search_index_ddl():
            conn.execute(text(stmt))


def upgrade_database(url: Optional[str] = None) -> None:
    """Apply Alembic migrations up to head."""
    from alembic import command
    from alembic.config import Config
    from comix.config import BACKEND_DIR

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url or get_settings().database_url)
    command.upgrade(cfg, "head")
