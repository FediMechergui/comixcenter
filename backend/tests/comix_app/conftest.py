import pytest

from comix import db
from comix.ingest import clients
from comix.bootstrap import bootstrap
from tests.comix_app.fakes import FakeComicvine, FakeMetron


@pytest.fixture
def database(tmp_path, monkeypatch):
    """Fresh SQLite file with the schema and seeded taxonomy; the global session factory points at it."""
    monkeypatch.setenv("COMIX_DATA_DIR", str(tmp_path / "data"))
    from comix import config
    config.get_settings.cache_clear()
    engine = db.configure(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    db.create_schema(engine)
    with db.session_scope() as session:
        bootstrap(session)
    yield engine
    engine.dispose()
    config.get_settings.cache_clear()


@pytest.fixture
def session(database):
    s = db.new_session()
    yield s
    s.close()


@pytest.fixture
def metron(monkeypatch):
    fake = FakeMetron()
    monkeypatch.setattr(clients, "_metron", fake)
    monkeypatch.setattr("comix.ingest.jobs.get_metron", lambda: fake)
    return fake


@pytest.fixture
def comicvine(monkeypatch):
    fake = FakeComicvine()
    monkeypatch.setattr(clients, "_comicvine", fake)
    monkeypatch.setattr("comix.ingest.jobs.get_comicvine", lambda: fake)
    return fake
