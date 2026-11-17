// Mesh links between placed devices: the Zigbee, Z-Wave and Thread topology the integration reads
// from ZHA, Z-Wave JS, Zigbee2MQTT and Matter (chartroom/mesh/get), drawn as lines coloured by link
// quality. Routes and parent links are drawn solid, other neighbours faint, and routers get a ring.
// Hovering a device names its role and highlights its route to the coordinator or border router.
// Weak spots (`weakSpots`) get a warning-coloured ring and a line in the popover.
// Loaded on demand, the first time the Mesh layer is switched on (or with the heatmap, whose signal
// map is built from the mesh's routers: signal-mesh.ts).
import type { ChartroomApi } from './api';
import type { Hass } from './ha-types';
import type { Plan } from './plan/models';
import type { Point } from './plan/types';
import { count } from './text';
import { h, s } from './ui';

export interface MeshNode {
  id: string;
  source: string;
  name: string;
  role: string | null;
  /** The Thread role (leader, router, REED, ...), for Matter nodes. */
  thread_role?: string | null;
  /** The next hop towards the coordinator or border router, when the network says. */
  via?: string | null;
  device_id?: string | null;
  entities?: string[];
}
export interface MeshLink {
  a: string;
  b: string;
  source: string;
  lqi?: number | null;
  rssi?: number | null;
  /** An end is offline: the link is from its last report. */
  offline?: boolean;
  /** What the network says the link is (see mesh.py); null when it does not say. */
  relationship?: 'route' | 'parent' | 'sibling' | 'neighbor' | null;
}
export interface Topology {
  nodes: MeshNode[];
  links: MeshLink[];
  sources: Record<string, string>;
}
export interface PlacedLink {
  a: Point;
  b: Point;
  /** 0 (bad) to 1 (good), or null when the network does not say. */
  quality: number | null;
  offline: boolean;
  /** A neighbour link that is no route or parent link: drawn faint. */
  faint: boolean;
  /** The two node ids. */
  key: string;
  label: string;
}
/**
 * A placed coordinator or router, drawn with a ring; a REED (could route, does not) fainter. An
 * end device gets one only when it is a weak spot.
 */
export interface PlacedNode {
  at: Point;
  ring: 'coordinator' | 'router' | 'reed' | 'end';
  weak: boolean;
}

/** How often the topology is read again while the layer is on. */
export const MESH_REFRESH_MS = 60_000;
const SOURCE_NAMES: Record<string, string> = {
  zha: 'ZHA',
  zwave_js: 'Z-Wave JS',
  zigbee2mqtt: 'Zigbee2MQTT',
  matter: 'Matter',
  test: 'Test',
};
const NETWORKS: Record<string, string> = {
  zha: 'Zigbee',
  zigbee2mqtt: 'Zigbee',
  zwave_js: 'Z-Wave',
  matter: 'Thread',
};
const RELATIONSHIPS: Record<string, string> = {
  route: 'route',
  parent: 'parent link',
  sibling: 'neighbour (sibling)',
  neighbor: 'neighbour',
};
/** The network a source's nodes are on: Zigbee, Z-Wave, Thread (or the source's own name). */
export const networkOf = (source: string): string =>
  NETWORKS[source] ?? SOURCE_NAMES[source] ?? source;
const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);
const nodeName = (n: MeshNode): string =>
  (n.name || n.id) + (n.thread_role ? ` (${n.thread_role})` : '');
/** "LQI 130, RSSI -63 dBm", or '' when the link has neither. */
const readings = (l: MeshLink): string =>
  [
    typeof l.lqi === 'number' ? `LQI ${Math.round(l.lqi)}` : '',
    typeof l.rssi === 'number' ? `RSSI ${Math.round(l.rssi)} dBm` : '',
  ]
    .filter(Boolean)
    .join(', ');

/** Link quality from 0 to 1: RSSI over -90..-40 dBm (the finer of the two), else LQI over 0..255. */
export function linkQuality(link: MeshLink): number | null {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  if (typeof link.rssi === 'number' && Number.isFinite(link.rssi))
    return clamp((link.rssi + 90) / 50);
  if (typeof link.lqi === 'number' && Number.isFinite(link.lqi)) return clamp(link.lqi / 255);
  return null;
}

/** Red (bad) through amber to green (good); grey when unknown. */
export const qualityColour = (q: number | null): string =>
  q === null ? '#8a8f98' : `hsl(${Math.round(q * 120)} 75% 40%)`;

/**
 * Where each node is on the plan: where a device marker or source shows one of its entities, or its
 * Home Assistant device (named by the marker, or an entity's).
 */
export function placeNodes(
  topology: Topology,
  plan: Plan,
  hass: Hass | undefined,
): Map<string, Point> {
  const byEntity = new Map<string, Point>();
  const byDevice = new Map<string, Point>();
  for (const p of [...(plan.devices ?? []), ...plan.sources]) {
    if (!p.entity_id) continue;
    if (!byEntity.has(p.entity_id)) byEntity.set(p.entity_id, p.position);
    const dev = ('device_id' in p && p.device_id) || hass?.entities?.[p.entity_id]?.device_id;
    if (dev && !byDevice.has(dev)) byDevice.set(dev, p.position);
  }
  const at = new Map<string, Point>();
  for (const n of topology.nodes) {
    const pos =
      (n.entities ?? []).map((e) => byEntity.get(e)).find((p) => p) ??
      (n.device_id ? byDevice.get(n.device_id) : undefined);
    if (pos) at.set(n.id, pos);
  }
  return at;
}

/** The links whose two ends are both on the plan (see `placeNodes`). */
export function placeLinks(topology: Topology, plan: Plan, hass: Hass | undefined): PlacedLink[] {
  const at = placeNodes(topology, plan, hass);
  const names = new Map(topology.nodes.map((n) => [n.id, nodeName(n)]));
  const out: PlacedLink[] = [];
  for (const l of topology.links) {
    const a = at.get(l.a);
    const b = at.get(l.b);
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
    const offline = l.offline === true;
    const rel = l.relationship ? ` · ${RELATIONSHIPS[l.relationship] ?? l.relationship}` : '';
    out.push({
      a,
      b,
      quality: linkQuality(l),
      offline,
      faint: l.relationship === 'sibling' || l.relationship === 'neighbor',
      key: pairKey(l.a, l.b),
      label: `${names.get(l.a)} – ${names.get(l.b)}: ${readings(l) || 'quality unknown'}${rel}${offline ? ' (offline, last report)' : ''}`,
    });
  }
  return out;
}

/** The placed coordinators, routers and weak spots, for their rings. */
export function placeRings(topology: Topology, plan: Plan, hass: Hass | undefined): PlacedNode[] {
  const at = placeNodes(topology, plan, hass);
  const weak = weakSpots(topology);
  return topology.nodes.flatMap((n): PlacedNode[] => {
    const p = at.get(n.id);
    const routes = n.role === 'coordinator' || n.role === 'router';
    if (!p || (!routes && !weak.has(n.id))) return [];
    const ring = n.thread_role === 'REED' ? 'reed' : routes ? n.role! : 'end';
    return [{ at: p, ring: ring as PlacedNode['ring'], weak: weak.has(n.id) }];
  });
}

/** A parent link weaker than this is poor: LQI (0-255) under 80, else RSSI under -85 dBm. */
export const POOR_LQI = 80;
export const POOR_RSSI = -85;
/** A router this many devices route through (by `via`) is one plug away from cutting them off. */
export const MANY_DEPENDANTS = 3;

/** The reading that makes a link poor, by RSSI when it has one (as `linkQuality`), else LQI; or null. */
function poorReading(l: MeshLink): string | null {
  if (typeof l.rssi === 'number' && Number.isFinite(l.rssi))
    return l.rssi < POOR_RSSI ? `RSSI ${Math.round(l.rssi)} dBm` : null;
  if (typeof l.lqi === 'number' && Number.isFinite(l.lqi))
    return l.lqi < POOR_LQI ? `LQI ${Math.round(l.lqi)}` : null;
  return null;
}

/**
 * The weak spots of a topology, by node id, with what makes each weak:
 * - a node that does not route (an end device, a Thread REED) whose parent link (to its `via`;
 *   without one, its only link marked `parent`) is poor: "Weak: only parent link is poor (LQI 62)";
 * - a router that MANY_DEPENDANTS or more nodes route through (their `via` chains pass it): "Weak:
 *   4 devices route through this". The coordinator is left out: every route ends there.
 */
export function weakSpots(topology: Topology): Map<string, string> {
  const out = new Map<string, string>();
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const dependants = new Map<string, number>();
  for (const n of topology.nodes) {
    const seen = new Set([n.id]);
    for (let hop = byId.get(n.via ?? ''); hop && !seen.has(hop.id); hop = byId.get(hop.via ?? '')) {
      seen.add(hop.id);
      if (hop.role === 'router') dependants.set(hop.id, (dependants.get(hop.id) ?? 0) + 1);
    }
    if (n.role !== 'end_device' && n.thread_role !== 'REED') continue;
    // The link to `via` when the network names the parent (none if that link is missing), else
    // the parent-marked links.
    const parents = topology.links.filter((l) => {
      const other = l.a === n.id ? l.b : l.b === n.id ? l.a : null;
      return other !== null && (n.via ? other === n.via : l.relationship === 'parent');
    });
    const poor = parents.length === 1 && poorReading(parents[0]!);
    if (poor) out.set(n.id, `Weak: only parent link is poor (${poor})`);
  }
  for (const [id, k] of dependants)
    if (k >= MANY_DEPENDANTS) out.set(id, `Weak: ${count(k, 'device')} route through this`);
  return out;
}

/** "Thread router (leader)", "Zigbee end device", "Thread REED: can route, does not yet". */
function roleText(n: MeshNode): string {
  const tr = n.thread_role;
  const role =
    tr === 'REED'
      ? 'REED: can route, does not yet'
      : n.role === 'router'
        ? `router${tr && tr !== 'router' ? ` (${tr})` : ''}`
        : (tr ?? n.role?.replace('_', ' ') ?? 'role unknown');
  return `${networkOf(n.source)} ${role}`;
}

/** The nodes of a device: shown by `entities`, or Home Assistant device `deviceId`. */
export function deviceNodes(
  topology: Topology,
  entities: readonly string[],
  deviceId: string | null | undefined,
  hass: Hass | undefined,
): MeshNode[] {
  const devices = new Set([deviceId, ...entities.map((e) => hass?.entities?.[e]?.device_id)]);
  devices.delete(undefined);
  devices.delete(null);
  return topology.nodes.filter(
    (n) =>
      (n.entities ?? []).some((e) => entities.includes(e)) ||
      (!!n.device_id && devices.has(n.device_id)),
  );
}

/** What the mesh says about a device: its role, and its route by `via` (the links on it). */
export interface MeshInfo {
  lines: string[];
  /** The links on the routes, by `pairKey`. */
  path: Set<string>;
}

/**
 * The nodes of a device (shown by `entities`, or Home Assistant device `deviceId`): their roles and
 * routes to the coordinator, e.g. "Route: → Plug (RSSI -63 dBm) → Border router (LQI 255) · 2 hops".
 */
export function meshInfo(
  topology: Topology,
  entities: readonly string[],
  deviceId: string | null | undefined,
  hass: Hass | undefined,
): MeshInfo {
  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const links = new Map(topology.links.map((l) => [pairKey(l.a, l.b), l]));
  const lines: string[] = [];
  const path = new Set<string>();
  const weak = weakSpots(topology);
  for (const n of deviceNodes(topology, entities, deviceId, hass)) {
    lines.push(roleText(n));
    if (n.role === 'coordinator') continue;
    const hops: string[] = [];
    const seen = new Set([n.id]);
    let cur = n;
    for (
      let next = byId.get(cur.via ?? '');
      next && !seen.has(next.id);
      next = byId.get(cur.via ?? '')
    ) {
      const key = pairKey(cur.id, next.id);
      const link = links.get(key);
      path.add(key);
      hops.push(`→ ${next.name || next.id}${link && readings(link) ? ` (${readings(link)})` : ''}`);
      seen.add(next.id);
      cur = next;
    }
    if (!hops.length) lines.push('Route: not reported');
    else
      lines.push(
        `Route: ${hops.join(' ')} · ${count(hops.length, 'hop')}${cur.role === 'coordinator' ? '' : ', then not reported'}`,
      );
    const w = weak.get(n.id);
    if (w) lines.push(w);
  }
  return { lines, path };
}

/** What the note under the plan says about each network source. */
export function sourceNote(topology: Topology | null, placed: number, error?: string): string {
  if (error) return `Mesh: ${error}`;
  if (!topology) return 'Mesh: loading…';
  const found = Object.entries(topology.sources).filter(([, v]) => v !== 'absent');
  if (!found.length) return 'Mesh: no ZHA, Z-Wave JS, Zigbee2MQTT or Matter network found';
  const parts = found.map(([k, v]) => `${SOURCE_NAMES[k] ?? k}${v === 'ok' ? '' : ` ${v}`}`);
  return `Mesh: ${count(placed, 'link')} on this plan · ${parts.join(', ')}`;
}

/** What the network poll last came to: the topology, kept when a later read fails. */
export interface TopologyState {
  topology: Topology | null;
  error: string;
}
type MeshApi = Pick<ChartroomApi, 'mesh'>;
interface Poll {
  readonly listeners: Set<(state: TopologyState) => void>;
  state: TopologyState | null;
  load: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | undefined;
}

/** One topology poll per connection (wsApi gives one api per connection), whoever shows it. */
const polls = new Map<MeshApi, Poll>();

function read(poll: Poll, api: MeshApi): Promise<void> {
  poll.load ??= api
    .mesh()
    .then(
      (topology): TopologyState => ({ topology, error: '' }),
      (err: { message?: string }): TopologyState => ({
        topology: poll.state?.topology ?? null,
        error: err?.message ?? 'could not read the network',
      }),
    )
    .then((state) => {
      poll.state = state;
      poll.load = null;
      for (const l of poll.listeners) l(state);
    });
  return poll.load;
}

/**
 * Hear the topology `api` reads now and every MESH_REFRESH_MS, until `stop`. Listeners on the same
 * api share one poll, which stops with the last of them; a later one hears the last result at once.
 * `ready` settles once there is a result.
 */
export function watchTopology(
  api: MeshApi,
  listener: (state: TopologyState) => void,
): { ready: Promise<void>; stop: () => void } {
  let poll = polls.get(api);
  if (!poll) {
    const p: Poll = { listeners: new Set(), state: null, load: null, timer: undefined };
    p.timer = setInterval(() => void read(p, api), MESH_REFRESH_MS);
    polls.set(api, (poll = p));
  }
  const p = poll;
  p.listeners.add(listener);
  if (p.state) listener(p.state);
  const ready = p.load ?? (p.state ? Promise.resolve() : read(p, api));
  const stop = (): void => {
    if (!p.listeners.delete(listener) || p.listeners.size > 0) return;
    clearInterval(p.timer);
    if (polls.get(api) === p) polls.delete(api);
  };
  return { ready, stop };
}

// Here rather than with the view's styles, so they load with the layer.
const STYLES = `
  .mesh[hidden] { display: none; }
  .mesh-link { stroke-width: 2.5px; vector-effect: non-scaling-stroke; stroke-linecap: round; opacity: 0.85; pointer-events: stroke; }
  .mesh-link.unknown { stroke-dasharray: 4 4; }
  .mesh-link.offline { stroke-dasharray: 1 5; opacity: 0.6; }
  .mesh-link.faint { stroke-width: 1.5px; opacity: 0.3; }
  .mesh.focus .mesh-link { opacity: 0.12; }
  .mesh.focus .mesh-link.on-path { stroke-width: 4px; opacity: 1; }
  .mesh-node { stroke: var(--primary-text-color, #222); stroke-width: 36px; stroke-linecap: round; vector-effect: non-scaling-stroke; opacity: 0.4; pointer-events: none; }
  .mesh-node.reed { opacity: 0.15; }
  .mesh-node.coordinator { stroke: var(--primary-color, #03a9f4); stroke-width: 40px; opacity: 0.7; }
  .mesh-node.weak { stroke: var(--warning-color, #ffa600); opacity: 0.8; }
`;

export class MeshLayer {
  readonly #lines: SVGGElement = s('g');
  readonly g: SVGGElement = s(
    'g',
    { class: 'mesh', hidden: true },
    s('style', {}, STYLES),
    this.#lines,
  );
  readonly note: HTMLElement = h('div', { class: 'mesh-note', hidden: true, role: 'status' });
  #on = false;
  #plan: Plan | null = null;
  #hass: Hass | undefined;
  #entities: unknown = null;
  #topology: Topology | null = null;
  #error = '';
  #stop: (() => void) | null = null;
  #watched: MeshApi | null = null;
  readonly #api: () => MeshApi | null;
  /** The links on the hovered device's route, by `pairKey`. */
  #path: Set<string> | null = null;
  /** Placed links, for tests. */
  links: PlacedLink[] = [];

  /** `api`: the integration's commands, once connected. */
  constructor(api: () => MeshApi | null) {
    this.#api = api;
  }

  setOn(on: boolean): Promise<void> {
    this.#on = on;
    this.g.toggleAttribute('hidden', !on);
    this.note.hidden = !on;
    if (!on) {
      this.dispose();
      return Promise.resolve();
    }
    this.#render();
    return this.#watch();
  }

  setPlan(plan: Plan | null): void {
    this.#plan = plan;
    this.#render();
  }

  setHass(hass: Hass | undefined): void {
    this.#hass = hass;
    // Placement depends on the entity registry only; states do not move anything.
    if (hass?.entities !== this.#entities) {
      this.#entities = hass?.entities;
      this.#render();
    }
    void this.#watch();
  }

  /** Follow the connection's topology poll while on (once connected). */
  #watch(): Promise<void> {
    const api = this.#api();
    // A new connection gets its own poll: leave the old one.
    if (this.#stop && api !== this.#watched) this.dispose();
    if (!this.#on || this.#stop || !api) return Promise.resolve();
    this.#watched = api;
    const { ready, stop } = watchTopology(api, (state) => {
      this.#topology = state.topology;
      this.#error = state.error;
      this.#render();
    });
    this.#stop = stop;
    return ready;
  }

  /** What the mesh says about a device (see `meshInfo`), without highlighting; null while off. */
  info(entities: readonly string[] | null, deviceId?: string | null): MeshInfo | null {
    return this.#on && this.#topology && entities
      ? meshInfo(this.#topology, entities, deviceId, this.#hass)
      : null;
  }

  /**
   * What the mesh says about the device a popover is about to show (see `meshInfo`), and highlight
   * its route; nothing while the layer is off. `focus(null)` drops the highlight.
   */
  focus(entities: readonly string[] | null, deviceId?: string | null): string[] {
    const info = this.info(entities, deviceId);
    const path = info?.path.size ? info.path : null;
    // The popover asks again on every state change: redraw only when the route changed.
    if ([...(path ?? [])].join() !== [...(this.#path ?? [])].join()) {
      this.#path = path;
      this.#render();
    }
    return info?.lines ?? [];
  }

  #render(): void {
    if (!this.#on) return;
    const t = this.#topology;
    const plan = this.#plan;
    this.links = t && plan ? placeLinks(t, plan, this.#hass) : [];
    const path = this.#path;
    this.g.classList.toggle('focus', !!path);
    this.#lines.replaceChildren(
      ...this.links.map((l) =>
        s(
          'line',
          {
            class: `mesh-link${l.quality === null ? ' unknown' : ''}${l.offline ? ' offline' : ''}${l.faint ? ' faint' : ''}${path?.has(l.key) ? ' on-path' : ''}`,
            x1: l.a[0],
            y1: l.a[1],
            x2: l.b[0],
            y2: l.b[1],
            stroke: qualityColour(l.quality),
          },
          s('title', {}, l.label),
        ),
      ),
      // A zero-length line with a round cap is a disc of a fixed size on screen; the marker drawn
      // over it leaves a ring.
      ...(t && plan ? placeRings(t, plan, this.#hass) : []).map((n) =>
        s('line', {
          class: `mesh-node ${n.ring}${n.weak ? ' weak' : ''}`,
          x1: n.at[0],
          y1: n.at[1],
          x2: n.at[0],
          y2: n.at[1],
        }),
      ),
    );
    this.note.textContent = sourceNote(t, this.links.length, this.#error);
  }

  dispose(): void {
    this.#path = null;
    this.#stop?.();
    this.#stop = null;
  }
}
