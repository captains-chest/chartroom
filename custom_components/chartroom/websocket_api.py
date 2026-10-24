"""Websocket commands: chartroom/plans/list, get, save, delete and subscribe."""

from __future__ import annotations

from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
import voluptuous as vol

from .const import DOMAIN, SIGNAL_PLAN_CHANGED
from .store import ChartroomStore
from .underlay import async_remove_underlay

PLAN_ID = vol.All(str, vol.Length(min=1, max=64), vol.Match(r"^[a-z0-9_-]+$"))


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the websocket commands (once per Home Assistant run)."""
    websocket_api.async_register_command(hass, ws_list_plans)
    websocket_api.async_register_command(hass, ws_get_plan)
    websocket_api.async_register_command(hass, ws_save_plan)
    websocket_api.async_register_command(hass, ws_delete_plan)
    websocket_api.async_register_command(hass, ws_subscribe_plans)


def _store(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg_id: int):
    store: ChartroomStore | None = hass.data.get(DOMAIN)
    if store is None:
        connection.send_error(msg_id, "not_loaded", "Chartroom is not set up")
    return store


@websocket_api.websocket_command({vol.Required("type"): "chartroom/plans/list"})
@callback
def ws_list_plans(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """List saved plans."""
    if (store := _store(hass, connection, msg["id"])) is None:
        return
    connection.send_result(msg["id"], {"plans": store.list_plans()})


@websocket_api.websocket_command(
    {vol.Required("type"): "chartroom/plans/get", vol.Required("plan_id"): PLAN_ID}
)
@callback
def ws_get_plan(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return one plan."""
    if (store := _store(hass, connection, msg["id"])) is None:
        return
    if (plan := store.get_plan(msg["plan_id"])) is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Plan not found")
        return
    connection.send_result(msg["id"], plan)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "chartroom/plans/save",
        vol.Required("plan_id"): PLAN_ID,
        vol.Required("plan"): vol.Schema(
            {
                vol.Required("name"): vol.All(str, vol.Length(min=1, max=100)),
                vol.Optional("floor_id"): vol.Any(str, None),
            },
            extra=vol.ALLOW_EXTRA,
        ),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_plan(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Create or replace a plan (admins only)."""
    if (store := _store(hass, connection, msg["id"])) is None:
        return
    saved = await store.async_save_plan(msg["plan_id"], msg["plan"])
    connection.send_result(msg["id"], saved)
    async_dispatcher_send(hass, SIGNAL_PLAN_CHANGED, {"plan_id": msg["plan_id"], "deleted": False})


@websocket_api.websocket_command(
    {vol.Required("type"): "chartroom/plans/delete", vol.Required("plan_id"): PLAN_ID}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_plan(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Delete a plan (admins only)."""
    if (store := _store(hass, connection, msg["id"])) is None:
        return
    if not await store.async_delete_plan(msg["plan_id"]):
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Plan not found")
        return
    await async_remove_underlay(hass, msg["plan_id"])
    connection.send_result(msg["id"], {"deleted": msg["plan_id"]})
    async_dispatcher_send(hass, SIGNAL_PLAN_CHANGED, {"plan_id": msg["plan_id"], "deleted": True})


@websocket_api.websocket_command({vol.Required("type"): "chartroom/plans/subscribe"})
@callback
def ws_subscribe_plans(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Send an event whenever a plan is saved or deleted, so open cards can reload it."""
    msg_id = msg["id"]

    @callback
    def forward(change: dict[str, Any]) -> None:
        connection.send_message(websocket_api.event_message(msg_id, change))

    connection.subscriptions[msg_id] = async_dispatcher_connect(hass, SIGNAL_PLAN_CHANGED, forward)
    connection.send_result(msg_id)
