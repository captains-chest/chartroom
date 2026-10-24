// The live heatmap under the SVG plan: picks the sensors for the active layer, has the worker
// triangulate them (only when the layout changes), eases values and the range, cross-fades layout
// changes, and draws with WebGL2 or, failing that, Canvas2D from the worker's field grid. The
// signal layer is traced instead (signal.ts): in one WebGL2 pass, or by the worker for Canvas2D.
// Loaded on demand, the first time a layer is switched on.
import { FADE_DISTANCE, fieldGrid, nodeValues, type FieldGrid, type FieldMesh } from './field';
import { workerUrl } from './field-worker';
import { planBounds } from './geometry';
import type { FieldPlan } from './field-plan';
import { GlRenderer, NO_DATA_ALPHA, NO_DATA_GREY } from './heat-gl';
import { AREA_SIZE, declutter, NAME_SIZE } from './labels';
import {
  LAYERS,
  TRANSITION_MS,
  easeOut,
  layerData,
  layerDomain,
  layoutKey,
  rampCss,
  rampLut,
  type HeatLayerId,
  type LayerData,
} from './heat';
import type { Hass } from './ha-types';
import type { Plan, Point } from './plan';
import {
  barrierSegments,
  SEG,
  SIGNAL_CELLS,
  signalInput,
  signalKey,
  type SignalInput,
} from './signal';
import { h, s } from './ui';
import type { View } from './viewport';
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from './worker-protocol';

/** Field opacity at full confidence inside the house. */
export const HEAT_OPACITY = 0.72;
export const RENDERER_KEY = 'chartroom:renderer';

type Pending = { resolve: (r: WorkerResponse) => void };
interface CanvasField {
  field: Float32Array;
  grid: FieldGrid;
  img: HTMLCanvasElement;
}
export interface Layout {
  key: string;
  /** The sensor nodes and per-cell weights, or null for the traced signal layer. */
  mesh: FieldMesh | null;
  field?: FieldPlan;
  grid: FieldGrid;
  ids: string[];
  signal?: SignalInput;
}

/** Talks to the field worker; runs the same handler in this thread when workers are unavailable. */
class FieldClient {
  #worker: Worker | null = null;
  #local: Promise<(req: WorkerRequest) => WorkerResponse> | null = null;
  #id = 0;
  #pending = new Map<number, Pending>();

  constructor() {
    try {
      this.#worker = new Worker(workerUrl(), { type: 'module' });
      this.#worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const p = this.#pending.get(e.data.id);
        this.#pending.delete(e.data.id);
        p?.resolve(e.data);
      });
      this.#worker.addEventListener('error', () => this.#toLocal());
    } catch {
      this.#toLocal();
    }
  }

  #toLocal(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#local ??= import('./worker-protocol').then((m) => m.createHandler());
    // Requests in flight are lost with the worker: replay is not worth it, fail them.
    for (const [id, p] of this.#pending) p.resolve({ type: 'error', id, message: 'worker failed' });
    this.#pending.clear();
  }

  request(req: WorkerRequestBody): Promise<WorkerResponse> {
    const full = { ...req, id: ++this.#id } as WorkerRequest;
    if (!this.#worker) {
      this.#local ??= import('./worker-protocol').then((m) => m.createHandler());
      return this.#local.then((handle) => handle(full));
    }
    return new Promise((resolve) => {
      this.#pending.set(full.id, { resolve });
      this.#worker?.postMessage(full);
    });
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#pending.clear();
  }
}

/** Colours a field grid through the ramp into an image of one pixel per cell. */
function colourise(
  field: Float32Array,
  grid: FieldGrid,
  domain: readonly [number, number],
  opacity: number,
  lut: Uint8Array,
  canvas: HTMLCanvasElement,
): void {
  if (canvas.width !== grid.nx || canvas.height !== grid.ny) {
    canvas.width = grid.nx;
    canvas.height = grid.ny;
  }
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.nx, grid.ny);
  const span = Math.max(1e-6, domain[1] - domain[0]);
  const grey = Math.round(255 * NO_DATA_GREY);
  for (let c = 0; c < grid.nx * grid.ny; c++) {
    const t = Math.min(1, Math.max(0, (field[c * 3]! - domain[0]) / span));
    const k = Math.round(t * 255) * 4;
    const d = c * 4;
    // Negative confidence: no data, drawn grey (as the GL colour pass does).
    const none = field[c * 3 + 1]! < 0;
    img.data[d] = none ? grey : lut[k]!;
    img.data[d + 1] = none ? grey : lut[k + 1]!;
    img.data[d + 2] = none ? grey : lut[k + 2]!;
    img.data[d + 3] = Math.round(
      255 * opacity * (none ? NO_DATA_ALPHA : field[c * 3 + 1]!) * field[c * 3 + 2]!,
    );
  }
  ctx.putImageData(img, 0, 0);
}

/** The Canvas2D fallback: the worker's field, coloured per cell and scaled up with smoothing. */
export class CanvasRenderer {
  readonly ctx: CanvasRenderingContext2D;
  #cur: CanvasField | null = null;
  #prev: CanvasField | null = null;
  #keepNext = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no Canvas2D');
    this.ctx = ctx;
  }

  setLayout(keepPrevious: boolean): void {
    this.#keepNext = keepPrevious;
    if (!keepPrevious) this.#prev = null;
  }

  setField(field: Float32Array, grid: FieldGrid): void {
    if (this.#keepNext && this.#cur) {
      this.#prev = this.#cur;
      this.#cur = null;
    }
    this.#keepNext = false;
    this.#cur = { field, grid, img: this.#cur?.img ?? document.createElement('canvas') };
  }

  get hasField(): boolean {
    return this.#cur !== null;
  }

  dropPrevious(): void {
    this.#prev = null;
  }

  draw(
    view: View,
    domain: readonly [number, number],
    opacity: number,
    mix: number,
    lut: Uint8Array,
  ): void {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const layer = (l: CanvasField, alpha: number): void => {
      colourise(l.field, l.grid, domain, opacity, lut, l.img);
      const kx = canvas.width / view.w;
      const ky = canvas.height / view.h;
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(
        l.img,
        (l.grid.x0 - view.x) * kx,
        (l.grid.y0 - view.y) * ky,
        l.grid.nx * l.grid.cell * kx,
        l.grid.ny * l.grid.cell * ky,
      );
    };
    if (this.#prev && mix < 1) layer(this.#prev, 1 - mix);
    if (this.#cur) layer(this.#cur, this.#prev && mix < 1 ? mix : 1);
    ctx.globalAlpha = 1;
  }

  /** The settled field (for the debug hooks). */
  get field(): Float32Array | null {
    return this.#cur?.field ?? null;
  }
}

interface Anim {
  from: number;
  to: number;
  t0: number;
}

const current = (a: Anim, now: number, ms: number): number =>
  ms <= 0 ? a.to : a.from + (a.to - a.from) * easeOut((now - a.t0) / ms);
const done = (a: Anim, now: number, ms: number): boolean =>
  ms <= 0 || now - a.t0 >= ms || a.from === a.to;

export type RendererKind = 'webgl2' | 'canvas';

/** A settled heat layer's internals, for the renderer-agreement tests. */
export interface DebugContext {
  renderer: RendererKind;
  gl: GlRenderer | null;
  c2d: CanvasRenderer | null;
  layout: Layout | null;
  view: View;
  values: number[];
  /** Put `values` into the GL renderer's mesh. */
  upload(): void;
  domain: [number, number];
  opacity: number;
  lut: Uint8Array;
  canvas: HTMLCanvasElement;
  outline: Point[];
  request(r: WorkerRequestBody): Promise<WorkerResponse>;
  canvasRenderer(c: HTMLCanvasElement): CanvasRenderer;
}

export class HeatLayer {
  readonly box: HTMLElement;
  readonly legend: HTMLElement;
  #canvas: HTMLCanvasElement;
  #gl: GlRenderer | null = null;
  #c2d: CanvasRenderer | null = null;
  #client = new FieldClient();
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
  #anims = new Map<string, Anim>();
  #domain: [Anim, Anim] | null = null;
  #fade: Anim | null = null;
  #raf = 0;
  #inflight = false;
  #fieldFor = '';
  #sig = '';
  #lut: Uint8Array = rampLut(LAYERS.temperature.ramp);
  #segments = 0;
  #idle: (() => void)[] = [];
  #reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Called when the set of readings changes (the view marks sensors and draws value labels). */
  onReadings: ((data: LayerData | null, domain: [number, number] | null) => void) | null = null;

  constructor(box: HTMLElement, legend: HTMLElement, renderer?: RendererKind) {
    this.box = box;
    this.legend = legend;
    this.#canvas = this.#newCanvas();
    this.#pickRenderer(
      renderer ?? (localStorage.getItem(RENDERER_KEY) === 'canvas' ? 'canvas' : 'webgl2'),
    );
  }

  get renderer(): RendererKind {
    return this.#gl ? 'webgl2' : 'canvas';
  }

  get layer(): HeatLayerId | null {
    return this.#layer;
  }

  get mode(): string {
    const L = this.#layout;
    return L ? (L.mesh?.mode ?? 'signal') : 'none';
  }

  get ms(): number {
    return this.#reduced ? 0 : TRANSITION_MS;
  }

  #newCanvas(): HTMLCanvasElement {
    const c = h('canvas', { class: 'heat', 'aria-hidden': 'true' });
    this.box.replaceChildren(c);
    return c;
  }

  #pickRenderer(kind: RendererKind): void {
    this.#gl?.dispose();
    this.#gl = null;
    this.#c2d = null;
    this.#canvas = this.#newCanvas();
    this.#resizeCanvas();
    if (kind === 'webgl2') {
      try {
        const canvas = this.#canvas;
        this.#gl = new GlRenderer(canvas);
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          // A context we dropped ourselves (dispose) is lost too, after the switch: ignore it.
          if (canvas === this.#canvas) this.setRenderer('canvas');
        });
      } catch {
        this.#gl = null;
        this.#canvas = this.#newCanvas();
        this.#resizeCanvas();
      }
    }
    if (!this.#gl) this.#c2d = new CanvasRenderer(this.#canvas);
    this.#gl?.setRamp(this.#lut);
    this.box.dataset['renderer'] = this.renderer;
  }

  /** Switch renderers (tests, or after a lost context); the field is rebuilt from the layout. */
  setRenderer(kind: RendererKind): void {
    this.#pickRenderer(kind);
    const L = this.#layout;
    if (L?.mesh) this.#applyLayout(L, false);
    else if (L) {
      // A traced field is not kept: trace it again for the new renderer.
      this.#layout = null;
      this.#wantKey = '';
      this.#refresh();
    }
  }

  setLayer(layer: HeatLayerId | null): void {
    if (layer === this.#layer) return;
    this.#layer = layer;
    if (layer) {
      this.#lut = rampLut(LAYERS[layer].ramp);
      this.#gl?.setRamp(this.#lut);
    }
    this.#domain = null;
    this.#refresh();
  }

  setPlan(plan: Plan | null): void {
    this.#plan = plan;
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
    if (!layer || !plan) {
      this.#data = null;
      this.#wantKey = this.#key = '';
      this.#layout = null;
      this.box.hidden = true;
      this.legend.hidden = true;
      this.#sig = '';
      this.onReadings?.(null, null);
      return;
    }
    const data = layerData(plan, this.#hass, layer);
    this.#data = data;
    const bounds = planBounds(plan);
    const outline = plan.outline;
    const input = layer === 'signal' ? signalInput(plan, this.#hass, data.readings) : null;
    this.#segments = input ? input.walls.length / SEG : 0;
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
          Object.assign(a, { from: current(a, now, this.ms), to: target[i], t0: now });
      });
    for (const r of data.readings) {
      const a = this.#anims.get(r.id);
      if (!a) this.#anims.set(r.id, { from: r.value, to: r.value, t0: now });
      else if (a.to !== r.value)
        Object.assign(a, { from: current(a, now, this.ms), to: r.value, t0: now });
    }
    const sig = JSON.stringify([key, values, target, data.excluded]);
    if (sig !== this.#sig) {
      this.#sig = sig;
      this.#renderLegend(data, target);
      this.onReadings?.(data, target);
    }
    if (data.readings.length === 0) {
      this.#wantKey = this.#key = key;
      this.#layout = null;
      this.box.hidden = true;
      this.#gl?.dropPrevious();
      this.#c2d?.dropPrevious();
      this.#settle();
      return;
    }
    this.box.hidden = false;
    if (key !== this.#wantKey) {
      this.#wantKey = key;
      const box = bounds ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const ids = data.readings.map((r) => r.id);
      const crossFade = this.#layout !== null;
      if (input) {
        const grid = fieldGrid(box, FADE_DISTANCE, SIGNAL_CELLS);
        const L: Layout = { key, mesh: null, grid, ids, signal: input };
        if (this.#gl) return this.#applyLayout(L, crossFade);
        this.#inflight = true;
        void this.#client
          .request({ type: 'signal', key, grid, outline, walls: input.walls, aps: input.aps })
          .then((res) => {
            this.#inflight = false;
            if (res.type !== 'field' || res.key !== this.#wantKey) return this.#settle();
            this.#applyLayout(L, crossFade);
            this.#c2d?.setField(res.field, res.grid);
          });
        return;
      }
      const grid = fieldGrid(box);
      void this.#client
        .request({
          type: 'mesh',
          key,
          sensors: data.readings.map((r) => r.position),
          outline,
          grid,
          walls,
          rooms: plan.rooms.map((r) => [...r.polygon]),
        })
        .then((res) => {
          if (res.type !== 'mesh' || res.key !== this.#wantKey) return;
          this.#applyLayout({ key, mesh: res.mesh, field: res.plan, grid, ids }, crossFade);
        });
    } else this.#start();
  }

  #applyLayout(L: Layout, crossFade: boolean): void {
    this.#layout = L;
    this.#key = L.key;
    this.#fieldFor = '';
    const outline = this.#plan?.outline ?? [];
    const fade = crossFade && this.ms > 0;
    if (this.#gl && L.field) this.#gl.setLayout(L.field, outline, fade);
    else if (this.#gl && L.signal) this.#gl.setSignal(L.signal, L.grid, outline, fade);
    else this.#c2d?.setLayout(fade);
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
      return a ? current(a, now, this.ms) : 0;
    });
  }

  #domainAt(now: number): [number, number] {
    const d = this.#domain;
    return d ? [current(d[0], now, this.ms), current(d[1], now, this.ms)] : [0, 1];
  }

  #moving(now: number): boolean {
    const L = this.#layout;
    if (!L) return false;
    if (this.#fade && !done(this.#fade, now, this.ms)) return true;
    if (this.#domain?.some((a) => !done(a, now, this.ms))) return true;
    return L.ids.some((id) => {
      const a = this.#anims.get(id);
      return !!a && !done(a, now, this.ms);
    });
  }

  #start(): void {
    if (!this.#raf) this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(_t: number): void {
    this.#raf = 0;
    const now = performance.now();
    const L = this.#layout;
    if (!L || L.key !== this.#key) return this.#settle();
    const values = this.#values(now);
    const mix = this.#fade ? current(this.#fade, now, this.ms) : 1;
    const domain = this.#domainAt(now);
    if (this.#gl) {
      if (L.mesh) this.#gl.setValues(nodeValues(L.mesh, values));
      this.#gl.draw(this.#view, domain, HEAT_OPACITY, mix);
    } else {
      const want = `${L.key}|${values.join(',')}`;
      if (L.mesh && want !== this.#fieldFor && !this.#inflight)
        this.#requestField(L.key, values, want);
      this.#c2d!.draw(this.#view, domain, HEAT_OPACITY, mix, this.#lut);
    }
    const moving = this.#moving(now);
    if (!moving && this.#fade) {
      this.#fade = null;
      this.#gl?.dropPrevious();
      this.#c2d?.dropPrevious();
    }
    if (moving || this.#inflight) this.#start();
    else this.#settle();
  }

  #requestField(key: string, values: number[], want: string): void {
    this.#inflight = true;
    void this.#client.request({ type: 'values', key, values }).then((res) => {
      this.#inflight = false;
      if (res.type !== 'field' || res.key !== this.#key) return;
      this.#c2d?.setField(res.field, res.grid);
      this.#fieldFor = want;
      this.#start();
    });
  }

  #drawOnce(): void {
    if (!this.#layout || this.#raf) return;
    this.#start();
  }

  #settle(): void {
    if (this.#raf || this.#inflight || this.#key !== this.#wantKey) return;
    for (const f of this.#idle.splice(0)) f();
  }

  /** Resolves when the field is drawn and nothing is moving (for tests and screenshots). */
  idle(): Promise<void> {
    if (!this.#raf && !this.#inflight && this.#key === this.#wantKey) return Promise.resolve();
    return new Promise((r) => this.#idle.push(r));
  }

  #renderLegend(data: LayerData, domain: [number, number]): void {
    const spec = LAYERS[data.layer];
    const vals = data.readings.map((r) => r.value);
    const fmt = (v: number): string => v.toFixed(spec.digits);
    const pos = (v: number): string =>
      `${(((v - domain[0]) / (domain[1] - domain[0])) * 100).toFixed(1)}%`;
    const children: (Node | string)[] = [
      h('div', { class: 'heat-title' }, `${spec.label} `, h('span', {}, data.unit)),
    ];
    const bar = h('div', { class: 'heat-bar' });
    bar.style.background = rampCss(spec.ramp);
    const signal = data.layer === 'signal';
    if (vals.length && !signal) {
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      for (const [v, cls] of [
        [lo, 'min'],
        [hi, 'max'],
      ] as const) {
        const tick = h('i', {
          class: `heat-tick ${cls}`,
          title: `${cls === 'min' ? 'Lowest' : 'Highest'} reading ${fmt(v)} ${data.unit}`,
        });
        tick.style.left = pos(v);
        bar.append(tick);
      }
    }
    children.push(
      bar,
      h(
        'div',
        { class: 'heat-scale' },
        h('span', {}, fmt(domain[0])),
        h('span', {}, fmt((domain[0] + domain[1]) / 2)),
        h('span', {}, fmt(domain[1])),
      ),
    );
    const note: string[] = [];
    const n = vals.length;
    if (signal)
      note.push(
        n ? `${n} source${n === 1 ? '' : 's'}` : 'No sources',
        `${this.#segments} wall segment${this.#segments === 1 ? '' : 's'}`,
      );
    else if (vals.length) {
      note.push(`${fmt(Math.min(...vals))}–${fmt(Math.max(...vals))} ${data.unit}`);
      note.push(`${vals.length} sensor${vals.length === 1 ? '' : 's'}`);
    } else note.push('No readings');
    if (data.excluded.length) note.push(`${data.excluded.length} left out`);
    children.push(h('div', { class: 'heat-note' }, note.join(' · ')));
    this.legend.replaceChildren(...children);
    this.legend.setAttribute(
      'aria-label',
      `${spec.label} ${fmt(domain[0])} to ${fmt(domain[1])} ${data.unit}. ${note.join(', ')}`,
    );
    this.legend.hidden = false;
  }

  /** What the e2e debug hooks (e2e/heat-debug.ts) read; call after `idle()`. */
  debug(): DebugContext {
    const now = performance.now();
    const values = this.#values(now);
    const mesh = this.#layout?.mesh;
    return {
      renderer: this.renderer,
      gl: this.#gl,
      c2d: this.#c2d,
      layout: this.#layout,
      view: this.#view,
      values,
      upload: () => mesh && this.#gl?.setValues(nodeValues(mesh, values)),
      domain: this.#domainAt(now),
      opacity: HEAT_OPACITY,
      lut: this.#lut,
      canvas: this.#canvas,
      outline: this.#plan?.outline ?? [],
      request: (r) => this.#client.request(r),
      canvasRenderer: (c) => new CanvasRenderer(c),
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#gl?.dispose();
    this.#client.dispose();
  }
}

/** Value labels next to the sensors of the active layer, at a constant size on screen. */
export function renderValueLabels(g: SVGGElement, data: LayerData | null): void {
  // Signal sources carry a level at 1 m, not a reading worth labelling.
  if (!data || data.layer === 'signal') {
    g.replaceChildren();
    return;
  }
  const spec = LAYERS[data.layer];
  const out: SVGElement[] = [];
  const at = (p: Point): { x: number; y: number } => ({ x: p[0], y: p[1] });
  for (const r of data.readings) {
    out.push(
      s(
        'text',
        { class: 'heat-value', ...at(r.position), 'data-id': r.id },
        `${r.value.toFixed(spec.digits)}${data.unit === '%' ? '%' : '°'}`,
      ),
    );
  }
  for (const x of data.excluded) {
    out.push(
      s(
        'text',
        { class: 'heat-value excluded', ...at(x.position), 'data-id': x.id },
        '–',
        s('title', {}, `${x.entity_id}: ${x.reason}, left out of the heatmap`),
      ),
    );
  }
  g.replaceChildren(...out);
}

/**
 * Keep value labels off the room names: move or hide them, and hide area labels they cover or
 * that are too small to read. Rerun after the labels change and on every zoom.
 */
export function declutterLabels(body: SVGGElement, values: SVGGElement, mpp: number): void {
  const num = (el: Element, a: string): number => Number(el.getAttribute(a)) || 0;
  const label = (el: Element, size: number) => ({
    x: num(el, 'x'),
    y: num(el, 'y'),
    size,
    chars: el.textContent?.length ?? 0,
  });
  const names = [...body.querySelectorAll('text.name')];
  const areas = [...body.querySelectorAll('text.area')];
  const rooms = names.map((n, i) => ({
    name: label(n, NAME_SIZE),
    area: label(areas[i] ?? n, AREA_SIZE),
  }));
  const texts = [...values.querySelectorAll('text.heat-value')];
  const r = declutter(
    texts.map((t) => ({ x: num(t, 'x'), y: num(t, 'y'), chars: t.textContent?.length ?? 0 })),
    rooms,
    mpp,
  );
  texts.forEach((t, i) => {
    t.classList.toggle('below', r.values[i] === 'below');
    t.classList.toggle('crowded', r.values[i] === 'hidden');
  });
  areas.forEach((a, i) => a.classList.toggle('crowded', !!r.areas[i]));
}
