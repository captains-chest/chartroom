"""Websocket API: chartroom/plans/*."""

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry, flush_store

from custom_components.chartroom.const import DOMAIN, STORAGE_KEY


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


async def test_rejects_bad_plan_id(hass: HomeAssistant, hass_ws_client) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": "chartroom/plans/save", "plan_id": "../etc", "plan": {"name": "x"}}
    )
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"


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
