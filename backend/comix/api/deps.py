import hmac
from typing import Any, Optional

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from comix.config import get_settings
from comix.db import get_db


def require_admin(x_admin_token: Optional[str] = Header(default=None)) -> None:
    """Curation endpoints: open when ADMIN_TOKEN is unset (local single-user), token-checked otherwise."""
    expected = get_settings().admin_token
    if expected and not (x_admin_token and hmac.compare_digest(x_admin_token, expected)):
        raise HTTPException(status_code=401, detail="Admin token required (X-Admin-Token header)")


def found(value: Any, what: str = "Not found") -> Any:
    if value is None:
        raise HTTPException(status_code=404, detail=what)
    return value


DB = Depends(get_db)
Admin = Depends(require_admin)
SessionT = Session
