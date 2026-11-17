// The live heatmap under the SVG plan: picks the sensors for the active layer, has the worker
// plan their per-cell weights (only when the layout changes), eases values and the range,
// cross-fades layout changes, and hands the field to a renderer (heat/models.ts FieldRenderer):
// WebGL2 or, failing that, Canvas2D from the worker's field grid. The signal layer is traced instead (signal.ts): in
// one WebGL2 pass, or by the worker for Canvas2D, from the routers of a mesh (signal-mesh.ts) or
// the access points and radios placed by hand. Loaded on demand, the first time a layer is
// switched on.
import { FADE_DISTANCE, fieldGrid } from './field';
import { planBounds } from './geometry';
import { CanvasRenderer } from './heat/canvas-renderer';
import { FieldClient } from './heat/field-client';
import { GlRenderer } from './heat/gl-renderer';
import { legendContent, renderLegend, signalNote } from './heat/legend';
import type { FieldRenderer, Layout } from './heat/models';
import type { FieldRequest, RendererKind } from './heat/types';
import { LAYERS, TRANSITION_MS } from './heat/constants';
import { easeOut, layerData, layerDomain, layoutKey, rampLut, staleAt } from './heat/functions';
import type { LayerData } from './heat/models';
import type { HeatLayerId } from './heat/types';
import type { Hass } from './ha-types';
import type { Topology } from './mesh-layer';
import { watchTopology } from './mesh-layer';
import type { Plan } from './plan/models';
import {
  barrierSegments,
  SIGNAL_CELLS,
  signalInput,
  signalKey,
  type CappedSignalInput,
} from './signal';
import {
  measuredLines,
  meshNetworks,
  meshSignal,
  type MeshNetwork,
  type MeshSignal,
} from './signal-mesh';
import { h } from './ui';
import type { View } from './viewport';

// The heat chunk's other export: plan-view.ts loads the value labels with the layer, lazily.
export { declutterLabels, renderValueLabels } from './heat/value-labels';

/** Field opacity at full confidence inside the house. */
export const HEAT_OPACITY = 0.72;
export const RENDERER_KEY = 'chartroom:renderer';
/** The signal map's network picked last ('' for the access points and radios). */
export const NETWORK_KEY = 'chartroom:signal-network';
const PLACED = '';

// Here rather than with the view's styles, so they load with the layer.
const PICKER_STYLES = `
  .heat-net { margin-top: 4px; }
  .heat-net select { pointer-events: auto; max-width: 100%; font: inherit; color: inherit; background: none;
    border: 1px solid var(--divider-color, #ccc); border-radius: 4px; padding: 1px 2px; }
`;

type MeshApi = Parameters<typeof watchTopology>[0];

const RENDERERS: Record<RendererKind, (c: HTMLCanvasElement, r: FieldRequest) => FieldRenderer> = {
  webgl2: (c) => new GlRenderer(c),
  canvas: (c, r) => new CanvasRenderer(c, r),
};

interface Anim {
  from: number;
  to: number;
  t0: number;
}

const current = (a: Anim, now: number, ms: number): number =>
  ms <= 0 ? a.to : a.from + (a.to - a.from) * easeOut((now - a.t0) / ms);
const done = (a: Anim, now: number, ms: number): boolean =>
  ms <= 0 || now - a.t0 >= ms || a.from === a.to;

export class HeatLayer {
  readonly box: HTMLElement;
  readonly legend: HTMLElement;
  // Set with each renderer (#newCanvas).
  #canvas!: HTMLCanvasElement;
  #renderer: FieldRenderer;
  readonly #client = new FieldClient();
  #layer: HeatLayerId | null = null;
  #plan: Plan | null = null;
  #hass: Hass | undefined;
  #view: View = { x: 0, y: 0, w: 1, h: 1 };
  #size = { w: 1, h: 1 };
  #data: LayerData | null = null;

  /** The readings on show (for tests). */
  get data(): LayerData | null {
    return this.#data;
  }
  #key = '';
  #wantKey = '';
  #layout: Layout | null = null;
  readonly #anims = new Map<string, Anim>();
  #domain: [Anim, Anim] | null = null;
  #fade: Anim | null = null;
  #raf = 0;
  /** Re-reads the states when a reading goes stale: that changes with time, not with `hass`. */
  #staleTimer: ReturnType<typeof setTimeout> | undefined;
  #sig = '';
  /** A drag in the editor is under way: keep the field's layout until it ends. */
  #preview = false;
  #lut: Uint8Array = rampLut(LAYERS.temperature.ramp);
  #signalNote: string[] = [];
  /** The signal map from a mesh: its topology (while the Signal layer is on), the network shown. */
  #topology: Topology | null = null;
  #watching: MeshApi | null = null;
  #stopWatch: (() => void) | null = null;
  #pick: string | null = null;
  #mesh: { topology: Topology; net: MeshNetwork; signal: MeshSignal; walls: Float32Array } | null =
    null;
  readonly #select = h('select', { 'aria-label': 'Signal from' });
  #options = '';
  /** Picks the network the signal map is built from, when there is more than one to pick. */
  readonly picker: HTMLElement = h(
    'div',
    { class: 'heat-net' },
    h('style', {}, PICKER_STYLES),
    this.#select,
  );
  /** The integration's commands (the mesh topology), once connected. */
  meshApi: () => MeshApi | null = () => null;
  readonly #idle: (() => void)[] = [];
  #disposed = false;
  /** How long readings ease to new values (none under reduced motion). */
  readonly #ms =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : TRANSITION_MS;
  /** Called when the set of readings changes (the view marks sensors and draws value labels). */
  onReadings: ((data: LayerData | null, domain: [number, number] | null) => void) | null = null;

  constructor(box: HTMLElement, legend: HTMLElement, renderer?: RendererKind) {
    this.box = box;
    this.legend = legend;
    this.#renderer = this.#pickRenderer(
      renderer ?? (localStorage.getItem(RENDERER_KEY) === 'canvas' ? 'canvas' : 'webgl2'),
    );
    this.#select.addEventListener('change', () => {
      this.#pick = this.#select.value;
      try {
        localStorage.setItem(NETWORK_KEY, this.#pick);
      } catch {
        // Not remembered.
      }
      this.#refresh();
    });
    try {
      this.#pick = localStorage.getItem(NETWORK_KEY);
    } catch {
      // Nothing remembered.
    }
  }

  get renderer(): RendererKind {
    return this.#renderer.kind;
  }

  get layer(): HeatLayerId | null {
    return this.#layer;
  }

  get mode(): string {
    const L = this.#layout;
    return L ? (L.mesh?.mode ?? 'signal') : 'none';
  }

  /** A new canvas in the box, sized for the view (a canvas keeps its first context type). */
  #newCanvas(): HTMLCanvasElement {
    const c = h('canvas', { class: 'heat', 'aria-hidden': 'true' });
    this.box.replaceChildren(c);
    this.#canvas = c;
    this.#resizeCanvas();
    return c;
  }

  /** The renderer of `kind` on a fresh canvas, or the Canvas2D fallback when it cannot start. */
  #pickRenderer(kind: RendererKind): FieldRenderer {
    const create = (k: RendererKind): FieldRenderer => {
      const canvas = this.#newCanvas();
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        // A context we dropped ourselves (switch, dispose) is lost too, later: ignore it.
        if (canvas === this.#canvas && !this.#disposed) this.setRenderer('canvas');
      });
      return RENDERERS[k](canvas, (r) => this.#client.request(r));
    };
    let r: FieldRenderer;
    try {
      r = create(kind);
    } catch {
      r = create('canvas');
    }
    r.setRamp(this.#lut);
    this.box.dataset['renderer'] = r.kind;
    return r;
  }

  /** Switch renderers (tests, or after a lost context); the field is rebuilt from the layout. */
  setRenderer(kind: RendererKind): void {
    this.#renderer.dispose();
    this.#renderer = this.#pickRenderer(kind);
    if (this.#layout) this.#applyLayout(this.#layout, false);
  }

  setLayer(layer: HeatLayerId | null): void {
    if (layer === this.#layer) return;
    this.#layer = layer;
    if (layer) {
      this.#lut = rampLut(LAYERS[layer].ramp);
      this.#renderer.setRamp(this.#lut);
    }
    this.#domain = null;
    this.#refresh();
  }

  /** A new plan, with the states to read it with (the view's latest: it may skip some). */
  setPlan(plan: Plan | null, hass: Hass | undefined = this.#hass, preview = false): void {
    this.#plan = plan;
    this.#hass = hass;
    this.#preview = preview;
    this.#refresh();
  }

  setHass(hass: Hass | undefined): void {
    this.#hass = hass;
    this.#refresh();
  }

  setView(view: View, w: number, h: number): void {
    this.#view = view;
    this.#size = { w, h };
    this.#resizeCanvas();
    this.#drawOnce();
  }

  #resizeCanvas(): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.#size.w * dpr));
    const hh = Math.max(1, Math.round(this.#size.h * dpr));
    if (this.#canvas.width !== w || this.#canvas.height !== hh) {
      this.#canvas.width = w;
      this.#canvas.height = hh;
    }
  }

  /** New plan, states or layer: re-triangulate if the layout changed, else ease to the new values. */
  #refresh(): void {
    const layer = this.#layer;
    const plan = this.#plan;
    clearTimeout(this.#staleTimer);
    if (!layer || !plan) {
      this.#unwatch();
      this.#data = null;
      this.#wantKey = this.#key = '';
      this.#layout = null;
      this.box.hidden = true;
      this.legend.hidden = true;
      this.#sig = '';
      this.onReadings?.(null, null);
      return;
    }
    let data = layerData(plan, this.#hass, layer);
    let input: CappedSignalInput | null = null;
    if (layer === 'signal') [data, input] = this.#signal(plan, data);
    else this.#unwatch();
    this.#data = data;
    const stale = staleAt(data, this.#hass);
    if (stale < Infinity && !this.#disposed)
      this.#staleTimer = setTimeout(() => this.#refresh(), stale - Date.now() + 1);
    const bounds = planBounds(plan);
    const outline = plan.outline;
    // Temperature and humidity stop at walls and closed doors: their layout depends on those.
    const walls = input ? [] : barrierSegments(plan, this.#hass);
    const key = `${layer}|${data.unit}|${input ? signalKey(input) : walls.join(',')}|${layoutKey(data.readings, outline)}|${bounds ? [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].join(',') : ''}`;
    const now = performance.now();
    const values = data.readings.map((r) => r.value);
    const target = layerDomain(layer, data.unit, values);
    if (!this.#domain)
      this.#domain = [
        { from: target[0], to: target[0], t0: now },
        { from: target[1], to: target[1], t0: now },
      ];
    else
      this.#domain.forEach((a, i) => {
        if (a.to !== target[i])
          Object.assign(a, { from: current(a, now, this.#ms), to: target[i], t0: now });
      });
    for (const r of data.readings) {
      const a = this.#anims.get(r.id);
      if (!a) this.#anims.set(r.id, { from: r.value, to: r.value, t0: now });
      else if (a.to !== r.value)
        Object.assign(a, { from: current(a, now, this.#ms), to: r.value, t0: now });
    }
    // The picker's options and whether it shows are in the legend too.
    const picker = input && !this.picker.hidden ? this.picker : null;
    const sig =
      key +
      JSON.stringify([values, target, data.excluded, this.#signalNote, !!picker && this.#options]);
    const changed = sig !== this.#sig;
    if (changed) {
      this.#sig = sig;
      renderLegend(this.legend, legendContent(data, target, this.#signalNote), picker);
      this.onReadings?.(data, target);
    }
    if (data.readings.length === 0) return this.#blank(key);
    // Planning a temperature or humidity field takes the worker a while: during a drag the field
    // keeps the layout it has and is planned again for where the drag ends.
    const hold = this.#preview && !input && this.#layout !== null;
    if (key !== this.#wantKey && !hold) {
      this.#wantKey = key;
      const box = bounds ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const ids = data.readings.map((r) => r.id);
      const crossFade = this.#layout !== null;
      if (input) {
        const grid = fieldGrid(box, FADE_DISTANCE, SIGNAL_CELLS);
        const L: Layout = { key, mesh: null, grid, ids, outline, signal: input };
        return this.#applyLayout(L, crossFade);
      }
      const grid = fieldGrid(box);
      void this.#client
        .request(
          {
            type: 'mesh',
            key,
            sensors: data.readings.map((r) => r.position),
            outline,
            grid,
            walls,
            rooms: plan.rooms.map((r) => [...r.polygon]),
          },
          // A newer layout replaces one still waiting.
          'layout',
        )
        .then((res) => {
          if (key !== this.#wantKey) return;
          if (res.type === 'mesh')
            return this.#applyLayout(
              { key, mesh: res.mesh, field: res.plan, grid, ids, outline },
              crossFade,
            );
          // Without a mesh there is no field; it is asked for again when the layout changes.
          console.warn('Chartroom heatmap:', res);
          this.#blank(key);
        });
      // Same layout and the same readings: the field on screen is already right.
    } else if (changed) this.#start();
  }

  /**
   * The signal layer's sources: the routers of the network picked (or with the most placed
   * routers) when the mesh has some, else the access points and radios in `placed`.
   */
  #signal(plan: Plan, placed: LayerData): [LayerData, CappedSignalInput] {
    this.#watch();
    const t = this.#topology;
    const nets = t ? meshNetworks(t, plan, this.#hass) : [];
    const hasPlaced = placed.readings.length + placed.excluded.length > 0;
    const net =
      this.#pick === PLACED && hasPlaced
        ? null
        : (nets.find((n) => n.name === this.#pick) ?? nets[0] ?? null);
    const options: [string, string][] = nets.map((n) => [n.name, `${n.name} routers`]);
    if (hasPlaced) options.push([PLACED, 'Access points and radios']);
    this.picker.hidden = options.length < 2;
    const key = options.join('\n');
    if (key !== this.#options) {
      this.#options = key;
      this.#select.replaceChildren(
        ...options.map(([v, label]) => h('option', { value: v }, label)),
      );
    }
    this.#select.value = net?.name ?? PLACED;
    if (!t || !net) {
      this.#mesh = null;
      const input = signalInput(plan, this.#hass, placed.readings);
      this.#signalNote = signalNote(input);
      return [placed, input];
    }
    const walls = signalInput(plan, this.#hass, []).walls;
    const signal = meshSignal(net, walls);
    const input = signalInput(plan, this.#hass, signal.sources);
    this.#mesh = { topology: t, net, signal, walls };
    this.#signalNote = [signal.note, ...signalNote(input).slice(1)];
    const data: LayerData = {
      layer: 'signal',
      unit: 'dBm',
      readings: signal.sources.map((s) => ({ ...s, entity_id: '' })),
      excluded: signal.down.map((s) => ({ ...s, entity_id: '', reason: 'unavailable' })),
    };
    return [data, input];
  }

  /** Follow the connection's topology poll (shared with the Mesh layer) while on the Signal layer. */
  #watch(): void {
    const api = this.meshApi();
    if (api === this.#watching || this.#disposed) return;
    this.#unwatch();
    if (!api) return;
    this.#watching = api;
    // The first result may come at once, inside this refresh: it reads #topology after this.
    let now = true;
    this.#stopWatch = watchTopology(api, (state) => {
      this.#topology = state.topology;
      if (!now) this.#refresh();
    }).stop;
    now = false;
  }

  #unwatch(): void {
    this.#stopWatch?.();
    this.#stopWatch = null;
    this.#watching = null;
    this.#topology = null;
    this.#mesh = null;
  }

  /**
   * For the popover, while the signal map comes from a mesh: the map's level at a device's spot
   * and its measured links next to the model's (see `measuredLines`); nothing otherwise.
   */
  probe(entities: readonly string[], deviceId?: string | null): string[] {
    const m = this.#layer === 'signal' ? this.#mesh : null;
    return m
      ? measuredLines(m.topology, m.net, m.signal, m.walls, entities, deviceId, this.#hass)
      : [];
  }

  /** Nothing to draw for layout `key`: hide the field and settle. */
  #blank(key: string): void {
    this.#wantKey = this.#key = key;
    this.#layout = null;
    this.box.hidden = true;
    this.#renderer.dropPrevious();
    this.#settle();
  }

  #applyLayout(L: Layout, crossFade: boolean): void {
    this.box.hidden = false;
    this.#layout = L;
    this.#key = L.key;
    const fade = crossFade && this.#ms > 0;
    this.#renderer.setLayout(L, fade);
    this.#fade = fade ? { from: 0, to: 1, t0: performance.now() } : null;
    // Readings that left the layout stop animating.
    for (const id of this.#anims.keys()) if (!L.ids.includes(id)) this.#anims.delete(id);
    this.#start();
  }

  /** Eased sensor values for the current layout at `now`. */
  #values(now: number): number[] {
    const L = this.#layout!;
    return L.ids.map((id) => {
      const a = this.#anims.get(id);
      return a ? current(a, now, this.#ms) : 0;
    });
  }

  #domainAt(now: number): [number, number] {
    const d = this.#domain;
    return d ? [current(d[0], now, this.#ms), current(d[1], now, this.#ms)] : [0, 1];
  }

  #moving(now: number): boolean {
    const L = this.#layout;
    if (!L) return false;
    if (this.#fade && !done(this.#fade, now, this.#ms)) return true;
    if (this.#domain?.some((a) => !done(a, now, this.#ms))) return true;
    return L.ids.some((id) => {
      const a = this.#anims.get(id);
      return !!a && !done(a, now, this.#ms);
    });
  }

  #start(): void {
    if (!this.#raf && !this.#disposed) this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(_t: number): void {
    this.#raf = 0;
    const now = performance.now();
    const L = this.#layout;
    if (!L || L.key !== this.#key) return this.#settle();
    const r = this.#renderer;
    const mix = this.#fade ? current(this.#fade, now, this.#ms) : 1;
    r.setValues(this.#values(now));
    r.draw(this.#view, this.#domainAt(now), HEAT_OPACITY, mix);
    const moving = this.#moving(now);
    if (!moving && this.#fade) {
      this.#fade = null;
      r.dropPrevious();
    }
    // The Canvas2D field comes from the worker: keep drawing until it lands.
    if (moving || r.busy) this.#start();
    else this.#settle();
  }

  #drawOnce(): void {
    if (!this.#layout || this.#raf) return;
    this.#start();
  }

  #settled(): boolean {
    return !this.#raf && !this.#renderer.busy && this.#key === this.#wantKey;
  }

  #settle(): void {
    if (this.#settled()) for (const f of this.#idle.splice(0)) f();
  }

  /** Resolves when the field is drawn and nothing is moving (for tests and screenshots). */
  idle(): Promise<void> {
    if (this.#settled()) return Promise.resolve();
    return new Promise((r) => this.#idle.push(r));
  }

  /** The test probe (e2e/heat-debug.ts): the drawn field, per cell; call after `idle()`. */
  readField(): Float32Array | null {
    return this.#renderer.readField();
  }

  dispose(): void {
    this.#unwatch();
    this.#disposed = true;
    clearTimeout(this.#staleTimer);
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#renderer.dispose();
    this.#client.dispose();
  }
}
