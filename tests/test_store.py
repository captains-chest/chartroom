"""Plan store: every write path gets the underlay URL check, not only the websocket handler."""

import re
from typing import Any

from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import flush_store

from custom_components.chartroom.const import STORAGE_KEY
from custom_components.chartroom.store import ChartroomStore, InvalidPlanError


def _plan(url: Any) -> dict[str, Any]:
    return {"name": "Up", "underlay": {"url": url, "width_px": 100, "height_px": 50}}


@pytest.mark.parametrize(
    "plan",
    [
        {"name": "Up"},
        {"name": "Up", "underlay": None},
        _plan("/api/chartroom/underlay/up"),
        _plan("/api/chartroom/underlay/up?v=0123456789ab"),
    ],
)
async def test_save_accepts_the_plans_own_underlay(
    hass: HomeAssistant, hass_storage: dict[str, Any], plan: dict[str, Any]
) -> None:
    store = ChartroomStore(hass)
    await store.async_load()
    assert await store.async_save_plan("up", plan) == {"id": "up", **plan}
    await flush_store(store._store)
    assert hass_storage[STORAGE_KEY]["data"]["plans"] == {"up": plan}


@pytest.mark.parametrize(
    ("plan", "message"),
    [
        (
            _plan(".example.com/x.png"),
            "underlay url must be /api/chartroom/underlay/up, optionally with ?v=<hex>",
        ),
        (
            _plan("/api/chartroom/underlay/down"),
            "underlay url must be /api/chartroom/underlay/up, optionally with ?v=<hex>",
        ),
        (_plan(None), "underlay must be null or an object with a url"),
        (
            {"name": "Up", "underlay": "/api/chartroom/underlay/up"},
            "underlay must be null or an object with a url",
        ),
    ],
)
async def test_save_refuses_any_other_underlay_url(
    hass: HomeAssistant, hass_storage: dict[str, Any], plan: dict[str, Any], message: str
) -> None:
    """A direct store save is refused too, and leaves the stored plan as it was."""
    old = _plan("/api/chartroom/underlay/up?v=ab")
    store = ChartroomStore(hass)
    await store.async_load()
    await store.async_save_plan("up", old)
    await flush_store(store._store)

    with pytest.raises(InvalidPlanError, match=f"^{re.escape(message)}$"):
        await store.async_save_plan("up", plan)

    assert store.get_plan("up") == {"id": "up", **old}
    await flush_store(store._store)
    assert hass_storage[STORAGE_KEY]["data"]["plans"] == {"up": old}
