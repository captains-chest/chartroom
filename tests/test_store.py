"""Plan store: every write path gets the save checks, not only the websocket handler."""

import re
from typing import Any

from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import flush_store

from custom_components.chartroom.const import PLAN_SCHEMA_VERSION, STORAGE_KEY
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


@pytest.mark.parametrize(
    "plan",
    [
        {"name": "U"},
        {"name": "x" * 100},
        {"name": "Up", "floor_id": None},
        {"name": "Up", "floor_id": "up"},
        {"name": "Up", "schema_version": PLAN_SCHEMA_VERSION},
        {"name": "Up", "walls": [], "anything": {"else": 1}},
    ],
)
async def test_save_accepts_a_valid_envelope(
    hass: HomeAssistant, hass_storage: dict[str, Any], plan: dict[str, Any]
) -> None:
    store = ChartroomStore(hass)
    await store.async_load()
    assert await store.async_save_plan("up", plan) == {"id": "up", **plan}
    await flush_store(store._store)
    assert hass_storage[STORAGE_KEY]["data"]["plans"] == {"up": plan}


@pytest.mark.parametrize(
    ("plan_id", "message"),
    [
        ("../etc", "does not match the expected pattern at 'plan_id'. Got '../etc'"),
        ("", "does not match the expected pattern at 'plan_id'. Got ''"),
        ("up\n", "does not match the expected pattern at 'plan_id'. Got 'up\\n'"),
        ("x" * 65, f"does not match the expected pattern at 'plan_id'. Got '{'x' * 65}'"),
        ("Up", "does not match the expected pattern at 'plan_id'. Got 'Up'"),
        (5, "expected str at 'plan_id'. Got 5"),
    ],
)
async def test_save_refuses_a_bad_plan_id(
    hass: HomeAssistant, hass_storage: dict[str, Any], plan_id: Any, message: str
) -> None:
    store = ChartroomStore(hass)
    await store.async_load()
    with pytest.raises(InvalidPlanError, match=f"^{re.escape(message)}$"):
        await store.async_save_plan(plan_id, {"name": "x"})
    assert store.plans() == {}
    assert STORAGE_KEY not in hass_storage


@pytest.mark.parametrize(
    ("plan", "message"),
    [
        ({"name": ""}, "length of value must be at least 1 at 'plan.name'. Got ''"),
        (
            {"name": "x" * 101},
            f"length of value must be at most 100 at 'plan.name'. Got '{'x' * 101}'",
        ),
        ({"name": 5}, "expected str at 'plan.name'. Got 5"),
        ({}, "required key not provided at 'plan.name'. Got None"),
        ({"name": "Up", "floor_id": 3}, "expected str or None at 'plan.floor_id'. Got 3"),
        (
            {"name": "Up", "schema_version": 1},
            "unsupported schema_version 1 at 'plan.schema_version'. Got 1",
        ),
        (
            {"name": "Up", "schema_version": 0},
            "unsupported schema_version 0 at 'plan.schema_version'. Got 0",
        ),
        (
            {"name": "Up", "schema_version": "1"},
            "unsupported schema_version '1' at 'plan.schema_version'. Got '1'",
        ),
        (
            {"name": "Up", "schema_version": 1.0},
            "unsupported schema_version 1.0 at 'plan.schema_version'. Got 1.0",
        ),
        (
            {"name": "Up", "schema_version": True},
            "unsupported schema_version True at 'plan.schema_version'. Got True",
        ),
        ("Up", "expected a mapping at 'plan'. Got 'Up'"),
        (None, "expected a mapping at 'plan'. Got None"),
    ],
)
async def test_save_refuses_a_bad_envelope(
    hass: HomeAssistant, hass_storage: dict[str, Any], plan: Any, message: str
) -> None:
    """A direct store save is refused, and leaves the stored plan as it was."""
    old = {"name": "Up", "schema_version": PLAN_SCHEMA_VERSION}
    store = ChartroomStore(hass)
    await store.async_load()
    await store.async_save_plan("up", old)
    await flush_store(store._store)

    with pytest.raises(InvalidPlanError, match=f"^{re.escape(message)}$"):
        await store.async_save_plan("up", plan)

    assert store.get_plan("up") == {"id": "up", **old}
    await flush_store(store._store)
    assert hass_storage[STORAGE_KEY]["data"]["plans"] == {"up": old}
