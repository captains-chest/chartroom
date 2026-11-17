"""Mesh topology from ZHA, Z-Wave JS, Zigbee2MQTT and Matter (Thread), for the panel's mesh layer.

Each source is optional: it is read only when its integration is loaded, and a missing or failing
source is reported in ``sources`` instead of breaking the others. The parsers are pure functions
over the data each integration exposes (ZHA's device info, Z-Wave JS node statistics, Zigbee2MQTT's
raw network map, the Matter server's Thread diagnostics), so they are tested with fixtures.
Everything is normalised to::

    nodes: [{id, source, name, role, thread_role, via, device_id, entities}]
    links: [{a, b, source, lqi, rssi, offline, relationship}]   # undirected, a < b

with role one of coordinator, router, end_device (or None), thread_role the Thread role behind it
(Matter only, else None), LQI 0-255 / RSSI in dBm, or None, and offline set when an end is a node
its network reports unavailable (the link is from its last report).

``relationship`` is what the network says the link is, or None when it does not say:

- ``route``: a hop of a node's route to the coordinator or border router (a routing table's next
  hop, Z-Wave's last working route);
- ``parent``: one end is the other's parent (Zigbee's join tree, a Thread child's parent);
- ``sibling``: two Zigbee routers in each other's neighbour table;
- ``neighbor``: the two hear each other, and nothing more is known.

``via`` is a node's next hop towards its coordinator or border router, when its network says: an
end device's parent, or a router's routing table entry for the coordinator. Following it gives the
path a node's traffic takes.
"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
import json
import logging
import math
import time
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_MESH_TEST: str = f"{DOMAIN}_mesh_test"
DATA_Z2M: str = f"{DOMAIN}_z2m"
DATA_OTBR: str = f"{DOMAIN}_otbr"
Z2M_BASE_TOPIC = "zigbee2mqtt"
# A raw network map makes every router scan its neighbours: ask at most this often.
Z2M_REFRESH_S = 600
Z2M_WAIT_S = 10

ROLES = {"coordinator": "coordinator", "router": "router", "enddevice": "end_device"}
# Zigbee neighbour relationships that are not a live link (ZHA names, Zigbee2MQTT numbers).
STALE_RELATIONSHIPS = {"PreviousChild", "Previous_Child", 4}
# What a Zigbee neighbour table entry says the neighbour is to the table's device (ZHA names,
# Zigbee2MQTT numbers): its parent, its child or a sibling. Anything else is just a neighbour.
ZIGBEE_PARENT = {"Parent", 0}
ZIGBEE_CHILD = {"Child", 1}
ZIGBEE_SIBLING = {"Sibling", 2}
# When both ends report a link, the more telling relationship wins.
RELATIONSHIP_RANK = {"neighbor": 1, "sibling": 2, "parent": 3, "route": 4}

# Z-Wave reports 125-127 in its RSSI fields as "not available" markers, not readings.
ZWAVE_RSSI_UNAVAILABLE_MIN = 125

# Thread Network Diagnostics (cluster 53) RoutingRole: (role, Thread role). A REED is an end device
# that can become a router; it is drawn as a router, since it is mains powered and listening.
THREAD_ROLES: dict[int, tuple[str, str]] = {
    2: ("end_device", "sleepy end device"),
    3: ("end_device", "end device"),
    4: ("router", "REED"),
    5: ("router", "router"),
    6: ("router", "leader"),
}
# Thread LQI is 0-3; the other sources use 0-255.
THREAD_LQI_SCALE = 85
# A neighbour or route entry not heard from for this long is no longer a link. Routers advertise at
# least every 32 s and OpenThread forgets a silent router after 100 s; a child polls its parent well
# within the default 240 s child timeout. The values are the Matter server's cached reports, so
# allow some slack over those. An end device's entry for its parent is kept whatever its age: it is
# the device's attachment, and its age keeps growing while the link works (a Matter button's parent
# entry read 173 181 s, then 346 004 s two days later, while the button kept working).
THREAD_STALE_AGE_S = 300
# Thread route cost of a link by its two-way link quality (0-3), as OpenThread counts it.
THREAD_LINK_COST = {1: 4, 2: 2, 3: 1}
# A route table's next hop when there is none.
THREAD_NO_ROUTER = 63
# Home Assistant hardware whose radio can run the OpenThread RCP firmware (``spinel``).
THREAD_RADIO_DOMAINS = (
    "homeassistant_connect_zbt2",
    "homeassistant_sky_connect",
    "homeassistant_yellow",
)


@dataclass(frozen=True)
class MeshNode:
    """A node as a parser sees it, before its Home Assistant device is resolved."""

    id: str
    source: str
    name: str
    role: str | None
    thread_role: str | None = None
    via: str | None = None
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
            "thread_role": self.thread_role,
            "via": self.via,
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

    def add(
        self, a: str, b: str, lqi: Any = None, rssi: Any = None, relationship: str | None = None
    ) -> None:
        if a == b:
            return
        key = (a, b) if a < b else (b, a)
        link = self.by_pair.setdefault(
            key,
            {
                "a": key[0],
                "b": key[1],
                "source": self.source,
                "lqi": None,
                "rssi": None,
                "offline": False,
                "relationship": None,
            },
        )
        if RELATIONSHIP_RANK.get(relationship or "", 0) > RELATIONSHIP_RANK.get(
            link["relationship"] or "", 0
        ):
            link["relationship"] = relationship
        for name, value in (("lqi", _num(lqi)), ("rssi", _num(rssi))):
            if value is not None:
                link[name] = value if link[name] is None else min(link[name], value)

    def list(self) -> list[dict[str, Any]]:
        return list(self.by_pair.values())


def _zigbee_relationship(value: Any) -> str:
    if value in ZIGBEE_PARENT or value in ZIGBEE_CHILD:
        return "parent"
    return "sibling" if value in ZIGBEE_SIBLING else "neighbor"


def _nwk(value: Any) -> int | None:
    """Return a Zigbee network address given as a number or as hex text ("0x1A2B")."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    try:
        return int(str(value), 16)
    except ValueError:
        return None


def _with_via(nodes: dict[str, MeshNode], via: dict[str, str]) -> list[MeshNode]:
    return [replace(n, via=via[nid]) if nid in via else n for nid, n in nodes.items()]


class _ZigbeeVia:
    """Each Zigbee node's next hop to the coordinator, from neighbour and routing tables.

    An end device's is its parent. A router's is its routing table's next hop for the coordinator;
    without one, the coordinator itself when it is in the router's neighbour table, since Zigbee
    sends to a neighbour directly. A router's parent is only where it joined, not where it sends.
    """

    def __init__(self, nodes: dict[str, MeshNode], links: _Links) -> None:
        self.nodes = nodes
        self.links = links
        self.via: dict[str, str] = {}
        self.direct: dict[str, str] = {}

    def neighbor(self, holder: str, nb: str, rel: Any, lqi: Any) -> None:
        """Add an entry for ``nb`` in ``holder``'s neighbour table."""
        self.links.add(holder, nb, lqi=lqi, relationship=_zigbee_relationship(rel))
        mine, theirs = self.nodes[holder].role, self.nodes[nb].role
        if rel in ZIGBEE_PARENT and mine == "end_device":
            self.via[holder] = nb
        elif rel in ZIGBEE_CHILD and theirs == "end_device":
            self.via[nb] = holder
        elif mine == "router" and theirs == "coordinator":
            self.direct[holder] = nb

    def route(self, holder: str, hop: str) -> None:
        """Note that ``holder``'s routing table sends to the coordinator through ``hop``."""
        if hop != holder:
            self.links.add(holder, hop, relationship="route")
            self.via[holder] = hop

    def nodes_with_via(self) -> list[MeshNode]:
        for router, coordinator in self.direct.items():
            if router not in self.via:
                self.route(router, coordinator)
        return _with_via(self.nodes, self.via)


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
    hops = _ZigbeeVia(nodes, links)
    by_nwk = {nwk: nid for nid, dev in present if (nwk := _nwk(dev.get("nwk"))) is not None}
    coordinator = next((nwk for nwk, nid in by_nwk.items() if nodes[nid].role == "coordinator"), 0)
    for a, dev in present:
        for nb in dev.get("neighbors") or ():
            b = _zha_id(nb.get("ieee", ""))
            if b in nodes and nb.get("relationship") not in STALE_RELATIONSHIPS:
                hops.neighbor(a, b, nb.get("relationship"), nb.get("lqi"))
        for rt in dev.get("routes") or ():
            if (
                isinstance(rt, dict)
                and str(rt.get("route_status", "")).lower() == "active"
                and _nwk(rt.get("dest_nwk")) == coordinator
                and (hop := by_nwk.get(_nwk(rt.get("next_hop")))) is not None
            ):
                hops.route(a, hop)
    return hops.nodes_with_via(), links.list()


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
    via: dict[str, str] = {}
    for nid, n in present:
        home = n.get("home_id")
        if n.get("is_controller") or home not in controllers:
            continue
        # Without a last working route, the link to the controller is assumed, not reported.
        relationship = "route" if n.get("lwr") else None
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
            links.add(hops[i], hops[i + 1], rssi=rssi if last else None, relationship=relationship)
        if relationship:
            via[nid] = hops[-2]
    return _with_via(nodes, via), links.list()


def parse_z2m(networkmap: dict[str, Any]) -> Topology:
    """Zigbee2MQTT's raw network map (the bridge/response/networkmap payload)."""
    data = networkmap.get("data", networkmap) if isinstance(networkmap, dict) else {}
    value = data.get("value", data) if isinstance(data, dict) else {}
    nodes: dict[str, MeshNode] = {}
    by_nwk: dict[int, str] = {}
    for n in value.get("nodes") or ():
        ieee = str(n.get("ieeeAddr") or "").lower()
        if not ieee:
            continue
        nid = f"z2m:{ieee}"
        role = _role(n.get("type"))
        if (nwk := _nwk(n.get("networkAddress"))) is not None:
            by_nwk[nwk] = nid
        # Home Assistant registers the coordinator as Zigbee2MQTT's Bridge device, not by its ieee.
        prefix = "zigbee2mqtt_bridge_" if role == "coordinator" else "zigbee2mqtt_"
        nodes[nid] = MeshNode(
            id=nid,
            source="zigbee2mqtt",
            name=str(n.get("friendlyName") or nid),
            role=role,
            identifiers=(("mqtt", f"{prefix}{ieee}"),),
        )
    coordinator = next((nwk for nwk, nid in by_nwk.items() if nodes[nid].role == "coordinator"), 0)
    links = _Links("zigbee2mqtt")
    hops = _ZigbeeVia(nodes, links)
    for link in value.get("links") or ():
        # A link is an entry of the target's neighbour table: the source is the neighbour.
        src = link.get("source") or {}
        dst = link.get("target") or {}
        a = f"z2m:{str(link.get('sourceIeeeAddr') or src.get('ieeeAddr') or '').lower()}"
        b = f"z2m:{str(link.get('targetIeeeAddr') or dst.get('ieeeAddr') or '').lower()}"
        rel = link.get("relationship")
        if a not in nodes or b not in nodes or rel in STALE_RELATIONSHIPS:
            continue
        hops.neighbor(b, a, rel, link.get("lqi", link.get("linkquality")))
        # The target's routing table entries whose next hop is the source (with routes asked for).
        if any(
            isinstance(rt, dict)
            and str(rt.get("status", "")).upper() == "ACTIVE"
            and _nwk(rt.get("destinationAddress")) == coordinator
            for rt in link.get("routes") or ()
        ):
            hops.route(b, a)
    return hops.nodes_with_via(), links.list()


def _thread_ext(value: Any) -> int | None:
    """Return a Thread extended address as the tables give it (an int), or None for 0 (unknown)."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _hardware_ext(interfaces: Any) -> int | None:
    """Return a node's own extended address: its Thread interface's hardware address."""
    for iface in interfaces if isinstance(interfaces, list) else ():
        if not isinstance(iface, dict) or iface.get("7") != 4:  # InterfaceTypeEnum.Thread
            continue
        try:
            raw = base64.b64decode(str(iface.get("4") or ""), validate=True)
        except ValueError:
            continue
        if len(raw) == 8:
            return int.from_bytes(raw)
    return None


def _thread_entry(
    entry: Any, by_ext: dict[int, str], age_field: str, check_age: bool
) -> str | None:
    """Return the node a neighbour or route table entry points at, unless unknown or stale."""
    if not isinstance(entry, dict) or (ext := _thread_ext(entry.get("0"))) is None:
        return None
    return by_ext.get(ext) if _thread_fresh(entry, age_field, check_age) else None


def matter_node_identifier(fabric: int, node_id: int) -> tuple[str, str]:
    """Return a Matter node's device registry identifier, as the Matter integration sets it."""
    return ("matter", f"deviceid_{fabric:016X}-{node_id:016X}-MatterNodeDevice")


def _thread_node(fabric: int, n: Any) -> MeshNode | None:
    """Return a Matter node on Thread as a mesh node, or None for bridges and other transports."""
    if not isinstance(n, dict) or n.get("is_bridge") or not isinstance(n.get("node_id"), int):
        return None
    attrs = n.get("attributes") or {}
    if "0/53/1" not in attrs:
        return None
    role, thread_role = THREAD_ROLES.get(attrs["0/53/1"], (None, None))
    ident = matter_node_identifier(fabric, n["node_id"])
    return MeshNode(
        id=f"matter:{fabric:016X}-{n['node_id']:016X}",
        source="matter",
        name=str(n.get("name") or f"Matter node {n['node_id']}"),
        role=role,
        thread_role=thread_role,
        identifiers=(ident,),
    )


def parse_thread(server: dict[str, Any], border_routers: list[dict[str, Any]]) -> Topology:
    """Return the Thread nodes of a Matter server, linked by each node's neighbour and route tables.

    ``server`` is shaped like the Matter server's diagnostics: ``info.compressed_fabric_id`` and
    ``nodes`` of ``{node_id, available, is_bridge, attributes, name?}``, attributes keyed
    ``endpoint/cluster/attribute``. Nodes without Thread diagnostics (Matter over Wi-Fi or Ethernet)
    and bridges are left out. ``border_routers`` are ``{ext_address, name, device_id}``: Thread
    neighbours that are no Matter node but a border router, drawn as the coordinator.
    """
    fabric = int((server.get("info") or {}).get("compressed_fabric_id") or 0)
    nodes: dict[str, MeshNode] = {}
    by_ext: dict[int, str] = {}
    present: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for n in server.get("nodes") or ():
        if (node := _thread_node(fabric, n)) is None:
            continue
        nodes[node.id] = node
        attrs = n.get("attributes") or {}
        if (ext := _hardware_ext(attrs.get("0/51/0"))) is not None:
            by_ext[ext] = node.id
        present.append((node.id, n, attrs))
    for br in border_routers:
        if (ext := _thread_ext(br.get("ext_address"))) is None or ext in by_ext:
            continue
        nid = f"thread:{ext:016x}"
        nodes[nid] = MeshNode(
            id=nid,
            source="matter",
            name=str(br.get("name") or "Border router"),
            role="coordinator",
            thread_role="border router",
            device_id=br.get("device_id"),
        )
        by_ext[ext] = nid

    net = _ThreadNet(nodes, by_ext, _thread_router_ids(present, by_ext))
    offline: set[str] = set()
    for nid, n, attrs in present:
        if n.get("available") is False:
            offline.add(nid)
        _thread_links(net, nodes[nid], attrs)
    out = net.links.list()
    for link in out:
        link["offline"] = link["a"] in offline or link["b"] in offline
    return _with_via(nodes, {k: v for k, v in net.via.items() if k != v}), out


@dataclass
class _ThreadNet:
    """A Thread network's links and next hops, added node by node from their tables."""

    nodes: dict[str, MeshNode]
    by_ext: dict[int, str]
    by_rid: dict[int, str]
    links: _Links = field(default_factory=lambda: _Links("matter"))
    via: dict[str, str] = field(default_factory=dict)


def _thread_links(net: _ThreadNet, node: MeshNode, attrs: dict[str, Any]) -> None:
    """Add a node's links from its neighbour and route tables, and note its next hops."""
    links, via, by_ext, by_rid = net.links, net.via, net.by_ext, net.by_rid
    border = {rid for rid, nid in by_rid.items() if net.nodes[nid].role == "coordinator"}
    nid = node.id
    # An end device's tables hold its parent only, whose age says nothing (see the constant).
    check_age = node.role != "end_device"
    # A REED is a child too, until it becomes a router: its one neighbour is its parent.
    child = not check_age or node.thread_role == "REED"
    for nb in attrs.get("0/53/7") or ():
        if (other := _thread_entry(nb, by_ext, "1", check_age)) is None:
            continue
        if child:
            via[nid] = other
        elif nb.get("13") is True:  # IsChild: the neighbour is this node's child.
            via[other] = nid
        lqi = _num(nb.get("5"))
        links.add(
            nid,
            other,
            lqi=None if lqi is None else lqi * THREAD_LQI_SCALE,
            rssi=nb.get("6") if nb.get("6") is not None else nb.get("7"),
            relationship="parent" if child or nb.get("13") is True else "neighbor",
        )
    # Route entries with a link established are direct links too, with LQI both ways.
    routes: dict[int, dict[str, Any]] = {}
    for rt in attrs.get("0/53/8") or ():
        if not isinstance(rt, dict) or not _thread_fresh(rt, "7", check_age):
            continue
        if isinstance(rid := rt.get("2"), int):
            routes[rid] = rt
        if rt.get("9") is not True or (other := _thread_entry(rt, by_ext, "7", False)) is None:
            continue
        lqis = [q for q in (_num(rt.get("5")), _num(rt.get("6"))) if q is not None]
        links.add(
            nid,
            other,
            lqi=min(lqis) * THREAD_LQI_SCALE if lqis else None,
            relationship="neighbor",
        )
    if not child and (hop := _thread_next_hop(routes, border)) in by_rid:
        via[nid] = by_rid[hop]
        links.add(nid, by_rid[hop], relationship="route")


def _thread_fresh(entry: dict[str, Any], age_field: str, check_age: bool) -> bool:
    age = _num(entry.get(age_field))
    return not check_age or age is None or age <= THREAD_STALE_AGE_S


def _thread_router_ids(
    present: list[tuple[str, dict[str, Any], dict[str, Any]]], by_ext: dict[int, str]
) -> dict[int, str]:
    """Return the nodes by Thread router ID, as their neighbours' and routes' entries give them."""
    out: dict[int, str] = {}
    for _nid, _n, attrs in present:
        for nb in attrs.get("0/53/7") or ():
            # A router's RLOC16 is its router ID shifted left 10, with no child bits.
            rloc = nb.get("2") if isinstance(nb, dict) else None
            ext = _thread_ext(nb.get("0")) if isinstance(nb, dict) else None
            if isinstance(rloc, int) and rloc & 0x1FF == 0 and ext in by_ext:
                out[rloc >> 10] = by_ext[ext]
        for rt in attrs.get("0/53/8") or ():
            rid = rt.get("2") if isinstance(rt, dict) else None
            ext = _thread_ext(rt.get("0")) if isinstance(rt, dict) else None
            if isinstance(rid, int) and ext in by_ext:
                out[rid] = by_ext[ext]
    return out


def _thread_link_cost(entry: dict[str, Any]) -> float:
    """Return the route cost of a router's established link, or infinity without one."""
    quality = min((_num(entry.get("5")) or 0), (_num(entry.get("6")) or 0))
    return THREAD_LINK_COST.get(int(quality), math.inf) if entry.get("9") is True else math.inf


def _thread_next_hop(routes: dict[int, dict[str, Any]], targets: set[int]) -> int | None:
    """Return the router ID a router sends to the border router through, as OpenThread picks it.

    ``routes`` is its route table by router ID. Each entry gives the direct link's quality and a
    next hop with the path cost from there; the cheaper way wins, the direct link on a tie.
    """
    best: tuple[float, int] | None = None
    for target in targets:
        if (entry := routes.get(target)) is None:
            continue
        ways = [(_thread_link_cost(entry), target)]
        hop = entry.get("3")
        cost = _num(entry.get("4"))
        if hop in routes and hop not in (target, THREAD_NO_ROUTER) and cost is not None:
            ways.append((_thread_link_cost(routes[hop]) + cost, hop))
        way = min(ways, key=lambda w: w[0])
        if math.isfinite(way[0]) and (best is None or way[0] < best[0]):
            best = way
    return best[1] if best else None


@callback
def _device_for(hass: HomeAssistant, ident: tuple[str, str]) -> dr.DeviceEntry | None:
    """Return the device registered under an identifier, or None.

    Identifiers are unique only within a config entry, so several devices can share one. The device
    owned by the identifier's own integration (``mqtt``, ``zwave_js``) wins, else the first found.
    """
    devices = dr.async_get(hass).async_get_devices(identifiers={ident})
    return next(
        (
            device
            for device in devices
            if (entry := hass.config_entries.async_get_entry(device.config_entry_id))
            and entry.domain == ident[0]
        ),
        next(iter(devices), None),
    )


@callback
def _resolve(hass: HomeAssistant, nodes: list[MeshNode]) -> list[dict[str, Any]]:
    """Return the wire nodes, with device and entity ids filled in from the registries."""
    ent_reg = er.async_get(hass)

    def resolved(node: MeshNode) -> dict[str, Any]:
        device_id = node.device_id or next(
            (device.id for ident in node.identifiers if (device := _device_for(hass, ident))),
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


@callback
def _thread_radio(hass: HomeAssistant) -> dr.DeviceEntry | None:
    """Return the device of the radio running OpenThread RCP firmware, if there is just one."""
    entries = [
        e
        for domain in THREAD_RADIO_DOMAINS
        for e in hass.config_entries.async_loaded_entries(domain)
        if e.data.get("firmware") == "spinel"
    ]
    if len(entries) != 1:
        return None
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entries[0].entry_id)
    return devices[0] if devices else None


async def _border_routers(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Return the OpenThread Border Routers Home Assistant knows, by their extended address.

    With one border router and one radio running OpenThread RCP firmware, the router is drawn at
    that radio's device. The address is asked once per loaded entry (it is a call to the router).
    """
    cache: dict[str, tuple[Any, int]] = hass.data.setdefault(DATA_OTBR, {})
    entries = hass.config_entries.async_loaded_entries("otbr")
    radio = _thread_radio(hass) if len(entries) == 1 else None
    out = []
    for entry in entries:
        data = entry.runtime_data
        cached = cache.get(entry.entry_id)
        if cached is None or cached[0] is not data:
            try:
                ext = int.from_bytes(await data.get_extended_address())
            except HomeAssistantError, aiohttp.ClientError, TimeoutError:
                _LOGGER.debug("Reading the border router's address failed", exc_info=True)
                continue
            cache[entry.entry_id] = cached = (data, ext)
        out.append(
            {
                "ext_address": cached[1],
                "name": (radio and (radio.name_by_user or radio.name)) or entry.title,
                "device_id": radio.id if radio else None,
            }
        )
    return out


async def _matter(hass: HomeAssistant) -> Topology | None:
    entries = hass.config_entries.async_loaded_entries("matter")
    if not entries:
        return None
    client = entries[0].runtime_data.adapter.matter_client
    fabric = client.server_info.compressed_fabric_id
    nodes = []
    for node in client.get_nodes():
        device = _device_for(hass, matter_node_identifier(fabric, node.node_id))
        nodes.append(
            {
                "node_id": node.node_id,
                "available": node.available,
                "is_bridge": node.is_bridge_device,
                "attributes": node.node_data.attributes,
                "name": device and (device.name_by_user or device.name),
            }
        )
    server = {"info": {"compressed_fabric_id": fabric}, "nodes": nodes}
    return parse_thread(server, await _border_routers(hass))


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
        for device in dr.async_get(hass).devices
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
                json.dumps({"type": "raw", "routes": True}),
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
    hass.data.pop(DATA_OTBR, None)


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
    return (("zha", _zha), ("zwave_js", _zwave), ("zigbee2mqtt", _z2m), ("matter", _matter))


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
