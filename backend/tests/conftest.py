import pytest
from app.browser.cdp import ChromeBrowser


@pytest.fixture(autouse=True)
def no_real_browser(monkeypatch):
    """Unit tests run offline: fail loudly instead of launching Chrome."""
    async def refuse(self, *args, **kwargs):
        raise RuntimeError("Unit tests must not launch a real browser")
    monkeypatch.setattr(ChromeBrowser, "start", refuse)
