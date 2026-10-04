from alembic import context

from comix.config import get_settings
from comix.db import make_engine
from comix.models import Base

config = context.config
target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    # The FTS5 search index (and its shadow tables) is managed by hand in migrations
    return not (type_ == "table" and name.startswith("search_index"))


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url") or get_settings().database_url,
                      target_metadata=target_metadata, literal_binds=True, render_as_batch=True,
                      include_object=include_object)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = make_engine(config.get_main_option("sqlalchemy.url") or get_settings().database_url)
    with engine.connect() as connection:
        # Batch mode lets later migrations alter SQLite tables (copy-and-move)
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True,
                          include_object=include_object)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
