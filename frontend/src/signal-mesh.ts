// The signal map from a mesh (docs/render-design.md, "Signal from the mesh"): every placed router
// of one network (Zigbee, Z-Wave or Thread) is a source, all at one level at 1 m fitted to the
// RSSI its placed nodes measure between them. End devices are receivers only. Pure, so the tests
// check the fit and the choice of sources; the heat layer shows the result.
import type { Hass } from './ha-types';
import { DEFAULT_TX_DBM } from './plan/constants';
import { isSignalSource } from './plan/functions';
import type { Plan } from './plan/models';
import type { Point } from './plan/types';
import { deviceNodes, networkOf, placeNodes, type Topology } from './mesh-layer';
import { SIGNAL_N, signalAt } from './signal';

/** A measured level (dBm) between two spots on the plan. */
export interface MeasuredLink {
  a: Point;
  b: Point;
  rssi: number;
}

/** One level at 1 m for a network's sources, and how far the model is from the measurements. */
export interface LevelFit {
  level: number;
  /** Root mean square of measured minus modelled, in dB. */
  rms: number;
  links: number;
}

/** Fewer measured links than this fit nothing: one link fits itself exactly. */
export const MIN_FIT_LINKS = 3;

/** Large enough that the model's -120 dBm floor never clips a path loss. */
const OFFSET = 1000;

/** The model's loss (dB) from `a` to `b`: distance and every wall the straight line crosses. */
export const pathLoss = (walls: Float32Array, a: Point, b: Point, n = SIGNAL_N): number =>
  OFFSET - signalAt({ walls, aps: new Float32Array([a[0], a[1], OFFSET]) }, b[0], b[1], n);

/**
 * The level at 1 m that best fits the measured links (least squares: the mean of measured level
 * plus modelled loss), with the RMS error left. Null with fewer than MIN_FIT_LINKS measurements.
 * The path-loss exponent and wall losses stay as they are: a handful of links in one home cannot
 * tell them apart, and fitting them overfits (docs/render-design.md).
 */
export function fitLevel(
  links: readonly MeasuredLink[],
  walls: Float32Array,
  n = SIGNAL_N,
): LevelFit | null {
  const m = links.filter((l) => Number.isFinite(l.rssi));
  if (m.length < MIN_FIT_LINKS) return null;
  const loss = m.map((l) => pathLoss(walls, l.a, l.b, n));
  const level = m.reduce((s, l, i) => s + l.rssi + loss[i]!, 0) / m.length;
  const sq = m.reduce((s, l, i) => s + (l.rssi - level + loss[i]!) ** 2, 0);
  return { level, rms: Math.sqrt(sq / m.length), links: m.length };
}

export interface PlacedMeshNode {
  name: string;
  at: Point;
  /** A coordinator or router (Thread REEDs and border routers too): a signal source. */
  router: boolean;
  /** Its entities are all unavailable: it extends nothing now. */
  down: boolean;
}

/** One network's placed nodes and the levels they measure between them. */
export interface MeshNetwork {
  name: string;
  nodes: Map<string, PlacedMeshNode>;
  /** Placed routers that are up: the network's sources. */
  routers: number;
  /** RSSI between two placed nodes, by node id. */
  links: { a: string; b: string; rssi: number }[];
  /** The level at 1 m typed on a hand-placed radio that is one of its nodes (its coordinator). */
  typed: number | null;
}

/** The networks with placed routers, most routers first. */
export function meshNetworks(
  topology: Topology,
  plan: Plan,
  hass: Hass | undefined,
): MeshNetwork[] {
  const at = placeNodes(topology, plan, hass);
  const nets = new Map<string, MeshNetwork>();
  const netOf = new Map<string, MeshNetwork>();
  for (const n of topology.nodes) {
    const p = at.get(n.id);
    if (!p) continue;
    const name = networkOf(n.source);
    let net = nets.get(name);
    if (!net)
      nets.set(name, (net = { name, nodes: new Map(), routers: 0, links: [], typed: null }));
    const states = (n.entities ?? []).map((e) => hass?.states?.[e]?.state).filter((s) => s);
    const router = n.role === 'coordinator' || n.role === 'router';
    const down = states.length > 0 && states.every((s) => s === 'unavailable');
    net.nodes.set(n.id, { name: n.name || n.id, at: p, router, down });
    if (router && !down) net.routers++;
    netOf.set(n.id, net);
  }
  for (const l of topology.links) {
    const net = netOf.get(l.a);
    if (!net || net !== netOf.get(l.b) || typeof l.rssi !== 'number') continue;
    const [a, b] = [net.nodes.get(l.a)!.at, net.nodes.get(l.b)!.at];
    if (a[0] !== b[0] || a[1] !== b[1]) net.links.push({ a: l.a, b: l.b, rssi: l.rssi });
  }
  for (const s of plan.sources) {
    if (!isSignalSource(s) || typeof s.tx_dbm !== 'number' || !s.entity_id) continue;
    for (const n of deviceNodes(topology, [s.entity_id], null, hass)) {
      const net = netOf.get(n.id);
      if (net) net.typed ??= s.tx_dbm;
    }
  }
  return [...nets.values()].filter((n) => n.routers > 0).sort((p, q) => q.routers - p.routers);
}

/** A network's sources at their level, and how that level was found. */
export interface MeshSignal {
  sources: { id: string; position: Point; value: number }[];
  /** Placed routers left out: their entities are unavailable. */
  down: { id: string; position: Point }[];
  level: number;
  fit: LevelFit | null;
  /** "Thread · 5 routers · fitted -52 dBm @1 m · ±5.5 dB", for the legend. */
  note: string;
}

const dbm = (v: number): string => `${Math.round(v)} dBm`;

/**
 * The sources of `net`: its routers that are up, at the level fitted to its measured links, else
 * the level typed on its coordinator's radio, else the default for a radio.
 */
export function meshSignal(net: MeshNetwork, walls: Float32Array): MeshSignal {
  const sources: MeshSignal['sources'] = [];
  const down: MeshSignal['down'] = [];
  const fit = fitLevel(
    net.links.map((l) => ({ a: net.nodes.get(l.a)!.at, b: net.nodes.get(l.b)!.at, rssi: l.rssi })),
    walls,
  );
  const level = fit?.level ?? net.typed ?? DEFAULT_TX_DBM.radio;
  for (const [id, n] of net.nodes)
    if (n.router && n.down) down.push({ id, position: n.at });
    else if (n.router) sources.push({ id, position: n.at, value: level });
  const how = fit
    ? `fitted ${dbm(level)} @1 m · ±${fit.rms.toFixed(1)} dB`
    : `${dbm(level)} @1 m (${net.typed === null ? 'default' : 'typed'}; ${net.links.length ? `${net.links.length} measured, too few to fit` : 'no RSSI to fit'})`;
  const routers = `${sources.length} router${sources.length === 1 ? '' : 's'}`;
  return { sources, down, level, fit, note: `${net.name} · ${routers} · ${how}` };
}

/**
 * What the map and the measurements say at a device's spot (shown by `entities`, or Home
 * Assistant device `deviceId`) for the popover: the map's level there from the other routers,
 * and each measured link next to what the model gives for it.
 */
export function measuredLines(
  topology: Topology,
  net: MeshNetwork,
  signal: MeshSignal,
  walls: Float32Array,
  entities: readonly string[],
  deviceId: string | null | undefined,
  hass: Hass | undefined,
): string[] {
  const lines: string[] = [];
  for (const node of deviceNodes(topology, entities, deviceId, hass)) {
    const me = net.nodes.get(node.id);
    if (!me) continue;
    const others = signal.sources
      .filter((s) => s.position[0] !== me.at[0] || s.position[1] !== me.at[1])
      .flatMap((s) => [s.position[0], s.position[1], s.value]);
    const here = signalAt({ walls, aps: new Float32Array(others) }, me.at[0], me.at[1]);
    lines.push(`Signal map here: ${others.length ? dbm(here) : 'no other router'}`);
    for (const l of net.links) {
      const other = l.a === node.id ? l.b : l.b === node.id ? l.a : null;
      if (other === null) continue;
      const o = net.nodes.get(other)!;
      lines.push(
        `${o.name}: measured ${dbm(l.rssi)}, map ${dbm(signal.level - pathLoss(walls, o.at, me.at))}`,
      );
    }
  }
  return lines;
}
