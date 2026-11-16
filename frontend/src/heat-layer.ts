// The live heatmap under the SVG plan: picks the sensors for the active layer, has the worker
// plan their per-cell weights (only when the layout changes), eases values and the range,
// cross-fades layout changes, and hands the field to a renderer (heat/models.ts FieldRenderer):
// WebGL2 or, failing that, Canvas2D from the worker's field grid. The signal layer is traced instead (signal.ts): in
// one WebGL2 pass, or by the worker for Canvas2D. Loaded on demand, the first time a layer is
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
import type { Plan } from './plan/models';
import { barrierSegments, SIGNAL_CELLS, signalInput, signalKey } from './signal';
import { h } from './ui';
import type { View } from './viewport';

// The heat chunk's other export: plan-view.ts loads the value labels with the layer, lazily.
export { declutterLabels, renderValueLabels } from './heat/value-labels';

/** Field opacity at full confidence inside the house. */
export const HEAT_OPACITY = 0.72;
export const RENDERER_KEY = 'chartroom:renderer';

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
  #lut: Uint8Array = rampLut(LAYERS.temperature.ramp);
  #signalNote: string[] = [];
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
  setPlan(plan: Plan | null, hass: Hass | undefined = this.#hass): void {
    this.#plan = plan;
    this.#hass = hass;
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
    const stale = staleAt(data, this.#hass);
    if (stale < Infinity && !this.#disposed)
      this.#staleTimer = setTimeout(() => this.#refresh(), stale - Date.now() + 1);
    const bounds = planBounds(plan);
    const outline = plan.outline;
    const input = layer === 'signal' ? signalInput(plan, this.#hass, data.readings) : null;
    this.#signalNote = input ? signalNote(input) : [];
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
    const sig = key + JSON.stringify([values, target, data.excluded, this.#signalNote]);
    const changed = sig !== this.#sig;
    if (changed) {
      this.#sig = sig;
      renderLegend(this.legend, legendContent(data, target, this.#signalNote));
      this.onReadings?.(data, target);
    }
    if (data.readings.length === 0) return this.#blank(key);
    if (key !== this.#wantKey) {
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
    this.#disposed = true;
    clearTimeout(this.#staleTimer);
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#renderer.dispose();
    this.#client.dispose();
  }
}
