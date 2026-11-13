"""Mesh topology from ZHA, Z-Wave JS and Zigbee2MQTT, for the panel's mesh layer.

Each source is optional: it is read only when its integration is loaded, and a missing or failing
source is reported in ``sources`` instead of breaking the others. The parsers are pure functions
over the data each integration exposes (ZHA's device info, Z-Wave JS node statistics, Zigbee2MQTT's
raw network map), so they are tested with fixtures. Everything is normalised to::

    nodes: [{id, source, name, role, device_id, entities}]
    links: [{a, b, source, lqi, rssi}]   # undirected, a < b

with role one of coordinator, router, end_device (or None) and LQI 0-255 / RSSI in dBm, or None.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
import json
import logging
import math
import time
from typing import Any

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_MESH_TEST: str = f"{DOMAIN}_mesh_test"
DATA_Z2M: str = f"{DOMAIN}_z2m"
Z2M_BASE_TOPIC = "zigbee2mqtt"
# A raw network map makes every router scan its neighbours: ask at most this often.
Z2M_REFRESH_S = 600
Z2M_WAIT_S = 10

ROLES = {"coordinator": "coordinator", "router": "router", "enddevice": "end_device"}
# Zigbee neighbour relationships that are not a live link (ZHA names, Zigbee2MQTT numbers).
STALE_RELATIONSHIPS = {"PreviousChild", "Previous_Child", 4}

# Z-Wave reports 125-127 in its RSSI fields as "not available" markers, not readings.
ZWAVE_RSSI_UNAVAILABLE_MIN = 125


@dataclass(frozen=True)
class MeshNode:
    """A node as a parser sees it, before its Home Assistant device is resolved."""

    id: str
    source: str
    name: str
    role: str | None
    device_id: str | None = None
    entities: tuple[str, ...] = ()
    # Device registry identifiers that find the node's device when the source does not say.
    identifiers: tuple[tuple[str, str], ...] = ()

    def as_wire(self) -> dict[str, Any]:
        """Return the node as chartroom/mesh/get sends it."""
        return {
            "id": self.id,
            "source": self.source,
            "name": self.name,
            "role": self.role,
            "device_id": self.device_id,
            "entities": list(self.entities),
        }


Topology = tuple[list[MeshNode], list[dict[str, Any]]]


def _role(value: Any) -> str | None:
    return ROLES.get(str(value or "").replace("_", "").replace(" ", "").lower())


def _num(value: Any) -> float | None:
    try:
        n = float(value)
    except TypeError, ValueError:
        return None
    return n if math.isfinite(n) else None


def _entities(values: Any) -> tuple[str, ...]:
    return tuple(str(e) for e in values or () if e)


class _Links:
    """Undirected links, merged: the weaker reading of the two directions is kept."""

    def __init__(self, source: str) -> None:
        self.source = source
        self.by_pair: dict[tuple[str, str], dict[str, Any]] = {}

    def add(self, a: str, b: str, lqi: Any = None, rssi: Any = None) -> None:
        if a == b:
            return
        key = (a, b) if a < b else (b, a)
        link = self.by_pair.setdefault(
            key, {"a": key[0], "b": key[1], "source": self.source, "lqi": None, "rssi": None}
        )
        for name, value in (("lqi", _num(lqi)), ("rssi", _num(rssi))):
            if value is not None:
                link[name] = value if link[name] is None else min(link[name], value)

    def list(self) -> list[dict[str, Any]]:
        return list(self.by_pair.values())


def _zha_id(ieee: Any) -> str:
    return f"zha:{str(ieee).lower()}"


def parse_zha(devices: list[dict[str, Any]]) -> Topology:
    """ZHA device info (as ``zha/devices`` returns it): neighbour tables give the links."""
    present = [
        (_zha_id(dev["ieee"]), dev) for dev in devices if isinstance(dev, dict) and dev.get("ieee")
    ]
    nodes = {
        nid: MeshNode(
            id=nid,
            source="zha",
            name=str(dev.get("user_given_name") or dev.get("name") or nid),
            role=_role(dev.get("device_type")),
            device_id=dev.get("device_reg_id") or None,
            entities=_entities(
                e.get("entity_id") for e in dev.get("entities") or () if isinstance(e, dict)
            ),
        )
        for nid, dev in present
    }
    links = _Links("zha")
    for a, dev in present:
        for nb in dev.get("neighbors") or ():
            b = _zha_id(nb.get("ieee", ""))
            if b in nodes and nb.get("relationship") not in STALE_RELATIONSHIPS:
                links.add(a, b, lqi=nb.get("lqi"))
    return list(nodes.values()), links.list()


def _zwave_rssi(value: Any) -> float | None:
    n = _num(value)
    return None if n is None or n >= ZWAVE_RSSI_UNAVAILABLE_MIN else n


def _zwave_key(home: Any, node_id: Any) -> str:
    """Return a node's key in its network, which is also its Z-Wave JS device identifier."""
    return f"{home}-{node_id}"


def parse_zwave(nodes_in: list[dict[str, Any]]) -> Topology:
    """Z-Wave JS nodes with their last working route (LWR): controller → repeaters → node."""
    present = [
        (f"zwave_js:{_zwave_key(n.get('home_id'), n['node_id'])}", n)
        for n in nodes_in
        if isinstance(n, dict) and n.get("node_id") is not None
    ]
    nodes = {
        nid: MeshNode(
            id=nid,
            source="zwave_js",
            name=str(n.get("name") or f"Node {n['node_id']}"),
            role="coordinator"
            if n.get("is_controller")
            else ("router" if n.get("is_routing") else "end_device"),
            device_id=n.get("device_id") or None,
            entities=_entities(n.get("entities")),
            identifiers=(("zwave_js", _zwave_key(n.get("home_id"), n["node_id"])),),
        )
        for nid, n in present
    }
    controllers = {n.get("home_id"): nid for nid, n in present if n.get("is_controller")}
    links = _Links("zwave_js")
    for nid, n in present:
        home = n.get("home_id")
        if n.get("is_controller") or home not in controllers:
            continue
        lwr = n.get("lwr") or {}
        hops = [controllers[home]] + [
            f"zwave_js:{_zwave_key(home, r)}" for r in lwr.get("repeaters") or () if r is not None
        ]
        hops = [h for h in hops if h in nodes] + [nid]
        rssi = _zwave_rssi(lwr.get("rssi"))
        if rssi is None:
            rssi = _zwave_rssi(n.get("rssi"))
        for i in range(len(hops) - 1):
            last = i == len(hops) - 2
            links.add(hops[i], hops[i + 1], rssi=rssi if last else None)
    return list(nodes.values()), links.list()


def parse_z2m(networkmap: dict[str, Any]) -> Topology:
    """Zigbee2MQTT's raw network map (the bridge/response/networkmap payload)."""
    data = networkmap.get("data", networkmap) if isinstance(networkmap, dict) else {}
    value = data.get("value", data) if isinstance(data, dict) else {}
    nodes: dict[str, MeshNode] = {}
    for n in value.get("nodes") or ():
        ieee = str(n.get("ieeeAddr") or "").lower()
        if not ieee:
            continue
        nid = f"z2m:{ieee}"
        role = _role(n.get("type"))
        # Home Assistant registers the coordinator as Zigbee2MQTT's Bridge device, not by its ieee.
        prefix = "zigbee2mqtt_bridge_" if role == "coordinator" else "zigbee2mqtt_"
        nodes[nid] = MeshNode(
            id=nid,
            source="zigbee2mqtt",
            name=str(n.get("friendlyName") or nid),
            role=role,
            identifiers=(("mqtt", f"{prefix}{ieee}"),),
        )
    links = _Links("zigbee2mqtt")
    for link in value.get("links") or ():
        src = link.get("source") or {}
        dst = link.get("target") or {}
        a = f"z2m:{str(link.get('sourceIeeeAddr') or src.get('ieeeAddr') or '').lower()}"
        b = f"z2m:{str(link.get('targetIeeeAddr') or dst.get('ieeeAddr') or '').lower()}"
        if a in nodes and b in nodes and link.get("relationship") not in STALE_RELATIONSHIPS:
            links.add(a, b, lqi=link.get("lqi", link.get("linkquality")))
    return list(nodes.values()), links.list()


@callback
def _resolve(hass: HomeAssistant, nodes: list[MeshNode]) -> list[dict[str, Any]]:
    """Return the wire nodes, with device and entity ids filled in from the registries."""
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)

    def resolved(node: MeshNode) -> dict[str, Any]:
        device_id = node.device_id or next(
            (
                device.id
                for ident in node.identifiers
                if (device := dev_reg.async_get_device(identifiers={ident}))
            ),
            None,
        )
        entities = node.entities
        if device_id and not entities:
            entities = tuple(e.entity_id for e in er.async_entries_for_device(ent_reg, device_id))
        return replace(node, device_id=device_id, entities=entities).as_wire()

    return [resolved(node) for node in nodes]


async def _zha(hass: HomeAssistant) -> Topology | None:
    if "zha" not in hass.config.components:
        return None
    from homeassistant.components.zha.helpers import (  # noqa: PLC0415
        get_zha_gateway_proxy,
    )

    try:
        proxy = get_zha_gateway_proxy(hass)
    except ValueError:
        return None
    devices = []
    for dev in proxy.device_proxies.values():
        info = dict(dev.zha_device_info)
        info["device_reg_id"] = dev.device_id
        devices.append(info)
    return parse_zha(devices)


async def _zwave(hass: HomeAssistant) -> Topology | None:
    if "zwave_js" not in hass.config.components:
        return None
    entries = [
        e
        for e in hass.config_entries.async_entries("zwave_js")
        if e.state is ConfigEntryState.LOADED
    ]
    out: list[dict[str, Any]] = []
    for entry in entries:
        client = getattr(getattr(entry, "runtime_data", None), "client", None)
        controller = getattr(getattr(client, "driver", None), "controller", None)
        if controller is None:
            continue
        for node in controller.nodes.values():
            stats = getattr(node, "statistics", None)
            lwr = getattr(stats, "lwr", None)
            out.append(
                {
                    "node_id": node.node_id,
                    "home_id": controller.home_id,
                    "name": getattr(node, "name", None),
                    "is_controller": getattr(node, "is_controller_node", False),
                    "is_routing": getattr(node, "is_routing", False),
                    "rssi": getattr(stats, "rssi", None),
                    "lwr": {
                        "repeaters": [r.node_id for r in getattr(lwr, "repeaters", None) or ()],
                        "rssi": getattr(lwr, "rssi", None),
                    }
                    if lwr
                    else None,
                }
            )
    return parse_zwave(out) if entries else None


@dataclass
class _Z2MState:
    unsub: CALLBACK_TYPE | None = None
    networkmap: dict[str, Any] | None = None
    received: float = 0.0
    requested: float = 0.0
    arrived: asyncio.Event = field(default_factory=asyncio.Event)
    # Held while subscribing, so concurrent requests subscribe once and no unsub is lost.
    subscribing: asyncio.Lock = field(default_factory=asyncio.Lock)


def _has_z2m_devices(hass: HomeAssistant) -> bool:
    return any(
        domain == "mqtt" and str(ident).startswith("zigbee2mqtt_")
        for device in dr.async_get(hass).devices.values()
        for domain, ident in device.identifiers
    )


async def _z2m(hass: HomeAssistant) -> Topology | str | None:
    if "mqtt" not in hass.config.components or not _has_z2m_devices(hass):
        return None
    from homeassistant.components import mqtt  # noqa: PLC0415

    if not mqtt.is_connected(hass):
        return "error"
    state: _Z2MState = hass.data.setdefault(DATA_Z2M, _Z2MState())
    async with state.subscribing:
        if state.unsub is None:

            @callback
            def received(msg: Any) -> None:
                try:
                    payload = json.loads(msg.payload)
                except ValueError:
                    return
                if isinstance(payload, dict) and payload.get("status", "ok") == "ok":
                    state.networkmap = payload
                    state.received = time.monotonic()
                    state.arrived.set()

            state.unsub = await mqtt.async_subscribe(
                hass, f"{Z2M_BASE_TOPIC}/bridge/response/networkmap", received
            )
    now = time.monotonic()
    if state.networkmap is None or now - state.received > Z2M_REFRESH_S:
        if now - state.requested > Z2M_REFRESH_S or state.requested == 0.0:
            state.requested = now
            state.arrived.clear()
            await mqtt.async_publish(
                hass,
                f"{Z2M_BASE_TOPIC}/bridge/request/networkmap",
                json.dumps({"type": "raw", "routes": False}),
            )
        if state.networkmap is None:
            try:
                await asyncio.wait_for(state.arrived.wait(), Z2M_WAIT_S)
            except TimeoutError:
                return "pending"
    return parse_z2m(state.networkmap or {})


@callback
def async_unload(hass: HomeAssistant) -> None:
    """Drop the Zigbee2MQTT subscription and the test topology."""
    state: _Z2MState | None = hass.data.pop(DATA_Z2M, None)
    if state and state.unsub:
        state.unsub()
    hass.data.pop(DATA_MESH_TEST, None)


async def _test_source(hass: HomeAssistant) -> Topology | None:
    """Read the topology set by chartroom/mesh/test_source (already checked by its schema)."""
    if (test := hass.data.get(DATA_MESH_TEST)) is None:
        return None
    nodes = [MeshNode(**{**n, "entities": tuple(n["entities"])}) for n in test["nodes"]]
    return nodes, [dict(link) for link in test["links"]]


Reader = Callable[[HomeAssistant], Awaitable[Topology | str | None]]


def _readers(hass: HomeAssistant) -> tuple[tuple[str, Reader], ...]:
    """Return the sources to read: only the test topology while one is set, else the real ones."""
    if hass.data.get(DATA_MESH_TEST) is not None:
        return (("test", _test_source),)
    return (("zha", _zha), ("zwave_js", _zwave), ("zigbee2mqtt", _z2m))


async def async_get_topology(hass: HomeAssistant) -> dict[str, Any]:
    """Every mesh Home Assistant knows about, with the state of each source."""
    nodes: list[MeshNode] = []
    links: list[dict[str, Any]] = []
    sources: dict[str, str] = {}
    for name, read in _readers(hass):
        try:
            got = await read(hass)
        except Exception:
            _LOGGER.debug("Reading the %s mesh failed", name, exc_info=True)
            sources[name] = "error"
            continue
        if got is None:
            sources[name] = "absent"
        elif isinstance(got, str):
            sources[name] = got
        else:
            sources[name] = "ok"
            nodes.extend(got[0])
            links.extend(got[1])
    return {"nodes": _resolve(hass, nodes), "links": links, "sources": sources}
