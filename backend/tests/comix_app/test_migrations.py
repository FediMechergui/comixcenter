from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from comix.config import BACKEND_DIR
from comix.db import make_engine, upgrade_database
from comix.models import Base


def _config(url: str) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def test_migrations_match_models_and_round_trip(tmp_path):
    url = f"sqlite:///{(tmp_path / 'm.db').as_posix()}"
    upgrade_database(url)
    engine = make_engine(url)
    tables = set(inspect(engine).get_table_names())
    assert set(Base.metadata.tables) <= tables and "search_index" in tables
    command.check(_config(url))          # raises if the models drifted from the migrations

    with engine.begin() as conn:
        conn.execute(text("INSERT INTO teams(name) VALUES ('Avengers')"))
        assert conn.execute(text("SELECT title FROM search_index WHERE search_index MATCH 'aveng*'")).scalar() == "Avengers"
    engine.dispose()
    command.downgrade(_config(url), "base")
    assert inspect(make_engine(url)).get_table_names() == ["alembic_version"]
