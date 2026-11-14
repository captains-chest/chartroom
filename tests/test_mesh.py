"""Mesh topology: the ZHA, Z-Wave JS and Zigbee2MQTT parsers, and chartroom/mesh/*."""

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.chartroom import mesh
from custom_components.chartroom.const import DOMAIN

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def _links(links: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    return {(link["a"], link["b"]): link for link in links}


def test_parse_zha() -> None:
    nodes, links = mesh.parse_zha(_load("zha_devices.json"))
    by_id = {n.id: n.as_wire() for n in nodes}
    assert set(by_id) == {
        "zha:00:12:4b:00:00:00:00:01",
        "zha:00:15:8d:00:00:00:00:02",
        "zha:00:15:8d:00:00:00:00:03",
    }
    plug = by_id["zha:00:15:8d:00:00:00:00:02"]
    assert plug == {
        "id": "zha:00:15:8d:00:00:00:00:02",
        "source": "zha",
        "name": "Hall plug",
        "role": "router",
        "device_id": "dev-plug",
        "entities": ["switch.hall_plug"],
    }
    assert by_id["zha:00:12:4b:00:00:00:00:01"]["role"] == "coordinator"
    assert by_id["zha:00:15:8d:00:00:00:00:03"]["role"] == "end_device"
    got = _links(links)
    # Both directions merge into one link with the weaker LQI; previous children and unknown
    # neighbours are dropped.
    assert set(got) == {
        ("zha:00:12:4b:00:00:00:00:01", "zha:00:15:8d:00:00:00:00:02"),
        ("zha:00:15:8d:00:00:00:00:02", "zha:00:15:8d:00:00:00:00:03"),
    }
    assert got[("zha:00:12:4b:00:00:00:00:01", "zha:00:15:8d:00:00:00:00:02")]["lqi"] == 180
    assert got[("zha:00:15:8d:00:00:00:00:02", "zha:00:15:8d:00:00:00:00:03")]["lqi"] == 90


def test_parse_zwave() -> None:
    nodes, links = mesh.parse_zwave(_load("zwave_nodes.json"))
    by_id = {n.id: n for n in nodes}
    home = 3735928559
    assert by_id[f"zwave_js:{home}-1"].role == "coordinator"
    assert by_id[f"zwave_js:{home}-2"].role == "router"
    assert by_id[f"zwave_js:{home}-4"].name == "Node 4"
    assert by_id[f"zwave_js:{home}-4"].identifiers == (("zwave_js", f"{home}-4"),)
    got = _links(links)
    ctl, dimmer, attic, n4 = (f"zwave_js:{home}-{i}" for i in (1, 2, 3, 4))
    assert set(got) == {(ctl, dimmer), (dimmer, attic), (ctl, n4)}
    # The LWR RSSI, else the node's; 125-127 mean "not available".
    assert got[(ctl, dimmer)]["rssi"] == -52
    assert got[(dimmer, attic)]["rssi"] == -80
    assert got[(ctl, n4)]["rssi"] is None
    assert all(link["lqi"] is None for link in links)


def test_parse_z2m() -> None:
    nodes, links = mesh.parse_z2m(_load("z2m_networkmap.json"))
    assert {n.id: n.role for n in nodes} == {
        "z2m:0x00124b0000000001": "coordinator",
        "z2m:0x00158d0000000002": "router",
        "z2m:0x00158d0000000003": "end_device",
    }
    got = _links(links)
    assert set(got) == {
        ("z2m:0x00124b0000000001", "z2m:0x00158d0000000002"),
        ("z2m:0x00158d0000000002", "z2m:0x00158d0000000003"),
    }
    assert got[("z2m:0x00124b0000000001", "z2m:0x00158d0000000002")]["lqi"] == 150
    assert got[("z2m:0x00158d0000000002", "z2m:0x00158d0000000003")]["lqi"] == 70
    identifiers = {n.id: n.identifiers for n in nodes}
    assert identifiers["z2m:0x00124b0000000001"] == (
        ("mqtt", "zigbee2mqtt_bridge_0x00124b0000000001"),
    )
    assert identifiers["z2m:0x00158d0000000002"] == (("mqtt", "zigbee2mqtt_0x00158d0000000002"),)


def test_parsers_tolerate_junk() -> None:
    nodes, links = mesh.parse_zha([{}, {"ieee": "x", "neighbors": [{}]}, "nope"])
    assert ([n.as_wire() for n in nodes], links) == (
        [
            {
                "id": "zha:x",
                "source": "zha",
                "name": "zha:x",
                "role": None,
                "device_id": None,
                "entities": [],
            }
        ],
        [],
    )
    assert mesh.parse_zwave([{}, {"node_id": 5, "lwr": {"repeaters": [None]}}])[1] == []
    assert mesh.parse_z2m({}) == ([], [])
    assert mesh.parse_z2m({"data": {"value": {"nodes": [{}], "links": [{}]}}}) == ([], [])


async def _setup(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_mesh_get_without_sources(hass: HomeAssistant, hass_ws_client) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "chartroom/mesh/get"})
    msg = await ws.receive_json()
    assert msg["success"]
    assert msg["result"] == {
        "nodes": [],
        "links": [],
        "sources": {"zha": "absent", "zwave_js": "absent", "zigbee2mqtt": "absent"},
    }


async def test_mesh_source_error_is_reported(hass: HomeAssistant, hass_ws_client) -> None:
    await _setup(hass)

    async def boom(hass: HomeAssistant) -> None:
        raise RuntimeError("driver gone")

    async def zha(hass: HomeAssistant) -> mesh.Topology:
        return mesh.parse_zha(_load("zha_devices.json"))

    ws = await hass_ws_client(hass)
    with patch.object(mesh, "_zwave", boom), patch.object(mesh, "_zha", zha):
        await ws.send_json_auto_id({"type": "chartroom/mesh/get"})
        msg = await ws.receive_json()
    assert msg["result"]["sources"] == {
        "zha": "ok",
        "zwave_js": "error",
        "zigbee2mqtt": "absent",
    }
    assert len(msg["result"]["nodes"]) == 3
    assert len(msg["result"]["links"]) == 2


async def test_mesh_resolves_registry(hass: HomeAssistant, hass_ws_client) -> None:
    """Zigbee2MQTT nodes find their Home Assistant device and entities by identifier."""
    await _setup(hass)
    other = MockConfigEntry(domain="mqtt")
    other.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=other.entry_id, identifiers={("mqtt", "zigbee2mqtt_0x00158d0000000003")}
    )
    er.async_get(hass).async_get_or_create(
        "binary_sensor", "mqtt", "motion-1", device_id=device.id, suggested_object_id="bedroom"
    )

    async def z2m(hass: HomeAssistant) -> mesh.Topology:
        return mesh.parse_z2m(_load("z2m_networkmap.json"))

    ws = await hass_ws_client(hass)
    with patch.object(mesh, "_z2m", z2m):
        await ws.send_json_auto_id({"type": "chartroom/mesh/get"})
        msg = await ws.receive_json()
    by_id = {n["id"]: n for n in msg["result"]["nodes"]}
    motion = by_id["z2m:0x00158d0000000003"]
    assert motion["device_id"] == device.id
    assert motion["entities"] == ["binary_sensor.bedroom"]
    assert "_identifiers" not in motion
    assert by_id["z2m:0x00124b0000000001"]["device_id"] is None


async def test_mesh_resolves_z2m_coordinator_to_bridge(hass: HomeAssistant, hass_ws_client) -> None:
    """The Zigbee2MQTT coordinator is Home Assistant's Bridge device, under its own identifier."""
    await _setup(hass)
    other = MockConfigEntry(domain="mqtt")
    other.add_to_hass(hass)
    bridge = dr.async_get(hass).async_get_or_create(
        config_entry_id=other.entry_id,
        identifiers={("mqtt", "zigbee2mqtt_bridge_0x00124b0000000001")},
    )
    er.async_get(hass).async_get_or_create(
        "binary_sensor",
        "mqtt",
        "bridge-connection",
        device_id=bridge.id,
        suggested_object_id="zigbee2mqtt_bridge_connection_state",
    )

    async def z2m(hass: HomeAssistant) -> mesh.Topology:
        return mesh.parse_z2m(_load("z2m_networkmap.json"))

    ws = await hass_ws_client(hass)
    with patch.object(mesh, "_z2m", z2m):
        await ws.send_json_auto_id({"type": "chartroom/mesh/get"})
        msg = await ws.receive_json()
    by_id = {n["id"]: n for n in msg["result"]["nodes"]}
    coordinator = by_id["z2m:0x00124b0000000001"]
    assert coordinator["device_id"] == bridge.id
    assert coordinator["entities"] == ["binary_sensor.zigbee2mqtt_bridge_connection_state"]


async def test_mesh_test_source(
    hass: HomeAssistant, hass_ws_client, hass_read_only_access_token
) -> None:
    await _setup(hass)
    ws = await hass_ws_client(hass)
    topology = {
        "nodes": [
            {"id": "c", "role": "coordinator", "entities": ["light.a"]},
            {"id": "r", "name": "Plug", "role": "router", "entities": ["switch.b"]},
        ],
        "links": [{"a": "c", "b": "r", "lqi": 200}],
    }
    await ws.send_json_auto_id({"type": "chartroom/mesh/test_source", "topology": topology})
    assert (await ws.receive_json())["success"]
    await ws.send_json_auto_id({"type": "chartroom/mesh/get"})
    result = (await ws.receive_json())["result"]
    assert result["sources"] == {"test": "ok"}
    assert result["nodes"][0] == {
        "id": "c",
        "source": "test",
        "name": "",
        "role": "coordinator",
        "device_id": None,
        "entities": ["light.a"],
    }
    assert result["links"] == [{"a": "c", "b": "r", "source": "test", "lqi": 200.0, "rssi": None}]

    # Only admins may set it.
    user_ws = await hass_ws_client(hass, hass_read_only_access_token)
    await user_ws.send_json_auto_id({"type": "chartroom/mesh/test_source", "topology": None})
    assert not (await user_ws.receive_json())["success"]

    await ws.send_json_auto_id({"type": "chartroom/mesh/test_source", "topology": None})
    assert (await ws.receive_json())["success"]
    await ws.send_json_auto_id({"type": "chartroom/mesh/get"})
    assert (await ws.receive_json())["result"]["sources"]["zha"] == "absent"


async def test_z2m_subscribes_once_under_concurrent_requests(hass: HomeAssistant) -> None:
    """Two cards asking at once share one subscription, and unloading removes it."""
    other = MockConfigEntry(domain="mqtt")
    other.add_to_hass(hass)
    dr.async_get(hass).async_get_or_create(
        config_entry_id=other.entry_id, identifiers={("mqtt", "zigbee2mqtt_0x00158d0000000003")}
    )
    hass.config.components.add("mqtt")
    callbacks: list[Any] = []
    unsub = MagicMock()

    async def subscribe(hass: HomeAssistant, topic: str, received: Any) -> MagicMock:
        callbacks.append(received)
        await asyncio.sleep(0)
        return unsub

    async def publish(hass: HomeAssistant, topic: str, payload: str) -> None:
        networkmap = (FIXTURES / "z2m_networkmap.json").read_text()
        for received in callbacks:
            received(MagicMock(payload=networkmap))

    with (
        patch("homeassistant.components.mqtt.is_connected", return_value=True),
        patch("homeassistant.components.mqtt.async_subscribe", subscribe),
        patch("homeassistant.components.mqtt.async_publish", publish),
    ):
        first, second = await asyncio.gather(mesh._z2m(hass), mesh._z2m(hass))

    assert len(callbacks) == 1
    assert first == second
    assert len(first[0]) == 3
    mesh.async_unload(hass)
    unsub.assert_called_once()


async def test_mesh_test_source_is_resolved(hass: HomeAssistant, hass_ws_client) -> None:
    """The test topology replaces the readers but goes through the same registry resolution."""
    await _setup(hass)
    other = MockConfigEntry(domain="mqtt")
    other.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=other.entry_id, identifiers={("mqtt", "plug")}
    )
    er.async_get(hass).async_get_or_create(
        "switch", "mqtt", "plug-1", device_id=device.id, suggested_object_id="plug"
    )
    ws = await hass_ws_client(hass)
    topology = {"nodes": [{"id": "p", "device_id": device.id}], "links": []}
    await ws.send_json_auto_id({"type": "chartroom/mesh/test_source", "topology": topology})
    assert (await ws.receive_json())["success"]
    await ws.send_json_auto_id({"type": "chartroom/mesh/get"})
    result = (await ws.receive_json())["result"]
    assert result["nodes"] == [
        {
            "id": "p",
            "source": "test",
            "name": "",
            "role": None,
            "device_id": device.id,
            "entities": ["switch.plug"],
        }
    ]


def _z2m_node(ieee: str) -> mesh.MeshNode:
    return mesh.MeshNode(
        id=f"z2m:{ieee}",
        source="zigbee2mqtt",
        name=ieee,
        role="router",
        identifiers=(("mqtt", f"zigbee2mqtt_{ieee}"),),
    )


async def test_resolve_finds_device_by_identifier(hass: HomeAssistant) -> None:
    """Nodes resolve to the device registered under their identifier, or to none."""
    entry = MockConfigEntry(domain="mqtt")
    entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id, identifiers={("mqtt", "zigbee2mqtt_0x01")}
    )
    nodes = mesh._resolve(hass, [_z2m_node("0x01"), _z2m_node("0x02")])
    assert [n["device_id"] for n in nodes] == [device.id, None]


async def test_has_z2m_devices(hass: HomeAssistant) -> None:
    """Only an MQTT device with a Zigbee2MQTT identifier counts."""
    entry = MockConfigEntry(domain="mqtt")
    entry.add_to_hass(hass)
    dev_reg = dr.async_get(hass)
    dev_reg.async_get_or_create(config_entry_id=entry.entry_id, identifiers={("mqtt", "tasmota_1")})
    assert not mesh._has_z2m_devices(hass)
    dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id, identifiers={("mqtt", "zigbee2mqtt_0x01")}
    )
    assert mesh._has_z2m_devices(hass)


async def test_resolve_prefers_device_of_identifier_domain(hass: HomeAssistant) -> None:
    """When entries share an identifier, the one from the identifier's integration wins."""
    other = MockConfigEntry(domain="other")
    other.add_to_hass(hass)
    mqtt = MockConfigEntry(domain="mqtt")
    mqtt.add_to_hass(hass)
    ident = {("mqtt", "zigbee2mqtt_0x01")}
    dev_reg = dr.async_get(hass)
    dev_reg.async_get_or_create(config_entry_id=other.entry_id, identifiers=ident)
    device = dev_reg.async_get_or_create(config_entry_id=mqtt.entry_id, identifiers=ident)
    [node] = mesh._resolve(hass, [_z2m_node("0x01")])
    assert node["device_id"] == device.id
