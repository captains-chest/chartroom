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

export class MeshLayer {
  readonly g: SVGGElement = s('g', { class: 'mesh', hidden: true });
  readonly note: HTMLElement = h('div', { class: 'mesh-note', hidden: true, role: 'status' });
  #on = false;
  #plan: Plan | null = null;
  #hass: Hass | undefined;
  #entities: unknown = null;
  #topology: Topology | null = null;
  #error = '';
  #timer = 0;
  readonly #api: () => Pick<ChartroomApi, 'mesh'> | null;
  #load: Promise<void> | null = null;
  /** Placed links, for tests. */
  links: PlacedLink[] = [];

  /** `api`: the integration's commands, once connected. */
  constructor(api: () => Pick<ChartroomApi, 'mesh'> | null) {
    this.#api = api;
  }

  setOn(on: boolean): Promise<void> {
    this.#on = on;
    this.g.toggleAttribute('hidden', !on);
    this.note.hidden = !on;
    clearInterval(this.#timer);
    this.#timer = 0;
    if (!on) return Promise.resolve();
    this.#timer = setInterval(() => void this.#refresh(), MESH_REFRESH_MS) as unknown as number;
    this.#render();
    return this.#refresh();
  }

  setPlan(plan: Plan | null): void {
    this.#plan = plan;
    this.#render();
  }

  setHass(hass: Hass | undefined): void {
    const first = !this.#hass && hass;
    this.#hass = hass;
    // Placement depends on the entity registry only; states do not move anything.
    if (hass?.entities !== this.#entities) {
      this.#entities = hass?.entities;
      this.#render();
    }
    if (first && this.#on) void this.#refresh();
  }

  /** Read the topology again (one request at a time). */
  #refresh(): Promise<void> {
    const api = this.#api();
    if (!this.#on || !api) return Promise.resolve();
    this.#load ??= api
      .mesh()
      .then(
        (t) => {
          this.#topology = t;
          this.#error = '';
        },
        (err: { message?: string }) => {
          this.#error = err?.message ?? 'could not read the network';
        },
      )
      .finally(() => {
        this.#load = null;
        this.#render();
      });
    return this.#load;
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
    clearInterval(this.#timer);
    this.#timer = 0;
  }
}
