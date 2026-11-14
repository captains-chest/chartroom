"""Websocket API: chartroom/plans/*."""

import json
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, flush_store

from custom_components.chartroom.const import (
    DOMAIN,
    PLAN_SCHEMA_VERSION,
    STORAGE_KEY,
    VERSION,
)

EXAMPLE_PLAN = Path(__file__).parents[1] / "frontend/test/fixtures/example-plan.json"


async def _setup(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_list_save_get_delete(
    hass: HomeAssistant, hass_ws_client, hass_storage: dict[str, Any]
) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)

    await ws.send_json_auto_id({"type": "chartroom/plans/list"})
    msg = await ws.receive_json()
    assert msg["success"]
    assert msg["result"] == {"plans": []}

    plan = {"name": "Ground floor", "floor_id": "ground", "walls": []}
    await ws.send_json_auto_id({"type": "chartroom/plans/save", "plan_id": "ground", "plan": plan})
    msg = await ws.receive_json()
    assert msg["success"]
    assert msg["result"] == {"id": "ground", **plan}

    await ws.send_json_auto_id({"type": "chartroom/plans/list"})
    msg = await ws.receive_json()
    assert msg["result"] == {
        "plans": [{"id": "ground", "name": "Ground floor", "floor_id": "ground"}]
    }

    await ws.send_json_auto_id({"type": "chartroom/plans/get", "plan_id": "ground"})
    msg = await ws.receive_json()
    assert msg["result"]["walls"] == []

    await flush_store(hass.data[DOMAIN]._store)
    assert hass_storage[STORAGE_KEY]["data"]["plans"]["ground"]["name"] == "Ground floor"

    await ws.send_json_auto_id({"type": "chartroom/plans/delete", "plan_id": "ground"})
    msg = await ws.receive_json()
    assert msg["success"]

    await ws.send_json_auto_id({"type": "chartroom/plans/get", "plan_id": "ground"})
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"


async def test_plans_survive_restart(hass: HomeAssistant, hass_storage: dict[str, Any]) -> None:
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "key": STORAGE_KEY,
        "data": {"plans": {"up": {"name": "Upstairs", "floor_id": "up"}}},
    }
    await _setup(hass)
    assert hass.data[DOMAIN].list_plans() == [{"id": "up", "name": "Upstairs", "floor_id": "up"}]


@pytest.mark.parametrize("plan_id", ["../etc", "", "up\n", "x" * 65, "Up"])
async def test_rejects_bad_plan_id(hass: HomeAssistant, hass_ws_client, plan_id: str) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": "chartroom/plans/save", "plan_id": plan_id, "plan": {"name": "x"}}
    )
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"
    assert msg["error"]["message"] == (
        f"does not match the expected pattern at 'plan_id'. Got {plan_id!r}"
    )
    assert hass.data[DOMAIN].plans() == {}


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
        ("Up", "expected a mapping at 'plan'. Got 'Up'"),
    ],
)
async def test_save_rejects_a_bad_envelope(
    hass: HomeAssistant, hass_ws_client, plan: Any, message: str
) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "chartroom/plans/save", "plan_id": "up", "plan": plan})
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"] == {"code": "invalid_format", "message": message}
    assert hass.data[DOMAIN].get_plan("up") is None


async def test_save_requires_admin(hass: HomeAssistant, hass_ws_client, hass_admin_user) -> None:
    await _setup(hass)
    hass_admin_user.groups = []
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": "chartroom/plans/save", "plan_id": "a", "plan": {"name": "A"}}
    )
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "unauthorized"


async def test_example_plan_round_trips(hass: HomeAssistant, hass_ws_client) -> None:
    """The traced example plan (frontend fixture) saves and loads unchanged."""
    plan = json.loads(EXAMPLE_PLAN.read_text(encoding="utf-8"))
    await _setup(hass)
    ws = await hass_ws_client(hass)

    await ws.send_json_auto_id({"type": "chartroom/plans/save", "plan_id": "example", "plan": plan})
    msg = await ws.receive_json()
    assert msg["success"], msg

    await ws.send_json_auto_id({"type": "chartroom/plans/get", "plan_id": "example"})
    msg = await ws.receive_json()
    assert msg["result"] == {"id": "example", **plan}


async def test_subscribe_reports_saves_and_deletes(hass: HomeAssistant, hass_ws_client) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "chartroom/plans/subscribe"})
    msg = await ws.receive_json()
    assert msg["success"]
    sub = msg["id"]

    await ws.send_json_auto_id(
        {"type": "chartroom/plans/save", "plan_id": "up", "plan": {"name": "Upstairs"}}
    )
    replies = [await ws.receive_json(), await ws.receive_json()]
    events = [m for m in replies if m["type"] == "event"]
    assert [e["id"] for e in events] == [sub]
    assert events[0]["event"] == {"plan_id": "up", "deleted": False}

    await ws.send_json_auto_id({"type": "chartroom/plans/delete", "plan_id": "up"})
    replies = [await ws.receive_json(), await ws.receive_json()]
    events = [m for m in replies if m["type"] == "event"]
    assert events[0]["event"] == {"plan_id": "up", "deleted": True}

    # Unsubscribing stops the events.
    await ws.send_json_auto_id({"type": "unsubscribe_events", "subscription": sub})
    assert (await ws.receive_json())["success"]
    await ws.send_json_auto_id(
        {"type": "chartroom/plans/save", "plan_id": "up", "plan": {"name": "Upstairs"}}
    )
    msg = await ws.receive_json()
    assert msg["type"] == "result"
    assert msg["success"]


async def test_info_reports_the_version(hass: HomeAssistant, hass_ws_client) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "chartroom/info"})
    msg = await ws.receive_json()
    assert msg["success"]
    assert msg["result"] == {"version": VERSION}


@pytest.mark.parametrize(
    ("schema_version", "accepted"),
    [
        (PLAN_SCHEMA_VERSION, True),
        (2, False),
        (0, False),
        ("1", False),
        (1.0, False),
        (True, False),
    ],
)
async def test_save_checks_schema_version(
    hass: HomeAssistant, hass_ws_client, schema_version: Any, accepted: bool
) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    plan = {"schema_version": schema_version, "name": "Up"}
    await ws.send_json_auto_id({"type": "chartroom/plans/save", "plan_id": "up", "plan": plan})
    msg = await ws.receive_json()
    assert msg["success"] is accepted
    if not accepted:
        assert msg["error"]["code"] == "invalid_format"
        assert msg["error"]["message"] == (
            f"unsupported schema_version {schema_version!r} at 'plan.schema_version'."
            f" Got {schema_version!r}"
        )


async def test_save_accepts_plan_without_schema_version(
    hass: HomeAssistant, hass_ws_client
) -> None:
    """Plans from before the field count as the current version, as normalizePlan reads them."""
    await _setup(hass)
    ws = await hass_ws_client(hass)
    plan = {"name": "Legacy", "walls": []}
    await ws.send_json_auto_id({"type": "chartroom/plans/save", "plan_id": "legacy", "plan": plan})
    msg = await ws.receive_json()
    assert msg["success"]
    assert msg["result"] == {"id": "legacy", **plan}


def _underlay(url: Any) -> dict[str, Any]:
    return {"url": url, "width_px": 100, "height_px": 50, "scale": 0.05, "origin": [0, 0]}


@pytest.mark.parametrize(
    "underlay",
    [
        None,
        _underlay("/api/chartroom/underlay/up"),
        _underlay("/api/chartroom/underlay/up?v=0123456789ab"),
    ],
)
async def test_save_accepts_the_plans_own_underlay(
    hass: HomeAssistant, hass_ws_client, underlay: Any
) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    plan = {"name": "Up", "underlay": underlay}
    await ws.send_json_auto_id({"type": "chartroom/plans/save", "plan_id": "up", "plan": plan})
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"] == {"id": "up", **plan}


@pytest.mark.parametrize(
    "underlay",
    [
        # Another host: the panel would send the user's token there.
        _underlay("https://example.com/x.png"),
        _underlay("//example.com/x.png"),
        _underlay("@example.com/x.png"),
        _underlay(".example.com/x.png"),
        _underlay("https://example.com/api/chartroom/underlay/up"),
        # Another path on Home Assistant.
        _underlay("/api/states"),
        _underlay("/api/chartroom/underlay/up/../../states"),
        _underlay("/api/chartroom/underlay/../states"),
        _underlay("/api/chartroom/underlay/up?v=1&x=https://example.com"),
        _underlay("/api/chartroom/underlay/up?v=XYZ"),
        _underlay("/api/chartroom/underlay/up#x"),
        _underlay("/api/chartroom/underlay/up\n"),
        _underlay("/api/chartroom/underlay/up?v=ab\n"),
        _underlay("/api/chartroom/underlay/"),
        _underlay("/api/chartroom/underlay/Up"),
        # Another plan's image.
        _underlay("/api/chartroom/underlay/down"),
        _underlay("/api/chartroom/underlay/down?v=ab"),
        # Not a URL at all.
        _underlay(None),
        _underlay(42),
        {"width_px": 100},
        "/api/chartroom/underlay/up",
        [],
    ],
)
async def test_save_rejects_any_other_underlay_url(
    hass: HomeAssistant, hass_ws_client, hass_storage: dict[str, Any], underlay: Any
) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    plan = {"name": "Up", "underlay": underlay}
    await ws.send_json_auto_id({"type": "chartroom/plans/save", "plan_id": "up", "plan": plan})
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"
    assert msg["error"]["message"] in (
        "underlay must be null or an object with a url",
        "underlay url must be /api/chartroom/underlay/up, optionally with ?v=<hex>",
    )
    assert hass.data[DOMAIN].get_plan("up") is None


async def test_stored_plan_with_a_bad_underlay_still_loads(
    hass: HomeAssistant, hass_ws_client, hass_storage: dict[str, Any]
) -> None:
    """A plan saved before the check keeps loading; the panel leaves its underlay out."""
    plan = {"name": "Up", "underlay": _underlay("https://example.com/x.png")}
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "key": STORAGE_KEY,
        "data": {"plans": {"up": plan}},
    }
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "chartroom/plans/get", "plan_id": "up"})
    msg = await ws.receive_json()
    assert msg["result"] == {"id": "up", **plan}
