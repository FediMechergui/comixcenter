"""First-run data every installation needs: the universe/era taxonomy and the local user."""
from typing import Dict

from sqlalchemy.orm import Session

from comix.models import User
from comix.taxonomy import seed_taxonomy

DEFAULT_USER_ID = 1


def bootstrap(session: Session) -> Dict[str, int]:
    created = seed_taxonomy(session)
    if session.get(User, DEFAULT_USER_ID) is None:
        session.add(User(id=DEFAULT_USER_ID, name="Reader"))
        created["users"] = 1
    session.flush()
    return created
