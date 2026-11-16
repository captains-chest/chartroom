// Mesh links between placed devices: the Zigbee and Z-Wave topology the integration reads from ZHA,
// Z-Wave JS and Zigbee2MQTT (chartroom/mesh/get), drawn as lines coloured by link quality.
// Loaded on demand, the first time the Mesh layer is switched on.
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
  device_id?: string | null;
  entities?: string[];
}
export interface MeshLink {
  a: string;
  b: string;
  source: string;
  lqi?: number | null;
  rssi?: number | null;
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
  label: string;
}

/** How often the topology is read again while the layer is on. */
export const MESH_REFRESH_MS = 60_000;
const SOURCE_NAMES: Record<string, string> = {
  zha: 'ZHA',
  zwave_js: 'Z-Wave JS',
  zigbee2mqtt: 'Zigbee2MQTT',
  test: 'Test',
};

/** Link quality from 0 to 1: LQI over 0..255, else RSSI over -90..-40 dBm. */
export function linkQuality(link: MeshLink): number | null {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  if (typeof link.lqi === 'number' && Number.isFinite(link.lqi)) return clamp(link.lqi / 255);
  if (typeof link.rssi === 'number' && Number.isFinite(link.rssi))
    return clamp((link.rssi + 90) / 50);
  return null;
}

/** Red (bad) through amber to green (good); grey when unknown. */
export const qualityColour = (q: number | null): string =>
  q === null ? '#8a8f98' : `hsl(${Math.round(q * 120)} 75% 40%)`;

/**
 * The links whose two ends are both on the plan. A node is placed where a device marker or source
 * shows one of its entities, or any entity of its Home Assistant device.
 */
export function placeLinks(topology: Topology, plan: Plan, hass: Hass | undefined): PlacedLink[] {
  const byEntity = new Map<string, Point>();
  const byDevice = new Map<string, Point>();
  for (const p of [...(plan.devices ?? []), ...plan.sources]) {
    if (!p.entity_id) continue;
    if (!byEntity.has(p.entity_id)) byEntity.set(p.entity_id, p.position);
    const dev = hass?.entities?.[p.entity_id]?.device_id;
    if (dev && !byDevice.has(dev)) byDevice.set(dev, p.position);
  }
  const at = new Map<string, Point>();
  const names = new Map<string, string>();
  for (const n of topology.nodes) {
    names.set(n.id, n.name || n.id);
    const pos =
      (n.entities ?? []).map((e) => byEntity.get(e)).find((p) => p) ??
      (n.device_id ? byDevice.get(n.device_id) : undefined);
    if (pos) at.set(n.id, pos);
  }
  const out: PlacedLink[] = [];
  for (const l of topology.links) {
    const a = at.get(l.a);
    const b = at.get(l.b);
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
    const quality = linkQuality(l);
    const parts = [
      typeof l.lqi === 'number' ? `LQI ${Math.round(l.lqi)}` : '',
      typeof l.rssi === 'number' ? `RSSI ${Math.round(l.rssi)} dBm` : '',
    ].filter(Boolean);
    out.push({
      a,
      b,
      quality,
      label: `${names.get(l.a)} – ${names.get(l.b)}: ${parts.join(', ') || 'quality unknown'}`,
    });
  }
  return out;
}

/** What the note under the plan says about each network source. */
export function sourceNote(topology: Topology | null, placed: number, error?: string): string {
  if (error) return `Mesh: ${error}`;
  if (!topology) return 'Mesh: loading…';
  const found = Object.entries(topology.sources).filter(([, v]) => v !== 'absent');
  if (!found.length) return 'Mesh: no ZHA, Z-Wave JS or Zigbee2MQTT network found';
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

export class MeshLayer {
  readonly g: SVGGElement = s('g', { class: 'mesh', hidden: true });
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

  #render(): void {
    if (!this.#on) return;
    const t = this.#topology;
    this.links = t && this.#plan ? placeLinks(t, this.#plan, this.#hass) : [];
    this.g.replaceChildren(
      ...this.links.map((l) =>
        s(
          'line',
          {
            class: l.quality === null ? 'mesh-link unknown' : 'mesh-link',
            x1: l.a[0],
            y1: l.a[1],
            x2: l.b[0],
            y2: l.b[1],
            stroke: qualityColour(l.quality),
          },
          s('title', {}, l.label),
        ),
      ),
    );
    this.note.textContent = sourceNote(t, this.links.length, this.#error);
  }

  dispose(): void {
    this.#stop?.();
    this.#stop = null;
  }
}
