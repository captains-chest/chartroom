// The plan as live SVG: underlay image (its own SVG, under the heatmap canvas), the plan body, and
// an overlay group the editor draws handles into. Handles pan (drag), zoom (wheel, pinch, buttons) and keeps the viewBox in metres.
import { planBounds } from './geometry';
import type { Hass } from './ha-types';
import type { LayerData } from './heat/models';
import type { HeatLayerId } from './heat/types';
import type { HeatLayer } from './heat-layer';
import type { MeshLayer } from './mesh-layer';
import { MarkerLayer, markerStyles } from './markers';
import type { Plan } from './plan/models';
import type { Point } from './plan/types';
import { planBody } from './plan-svg';
import { h, s } from './ui';
import {
  fitView,
  metresPerPixel,
  panBy,
  toPlan,
  type View,
  viewBoxOf,
  withAspect,
  zoomAt,
} from './viewport';

/** The editor's hooks into pointer handling. Returning true from `down` takes the gesture. */
export interface PointerDelegate {
  down(p: Point, e: PointerEvent): boolean;
  move(p: Point, e: PointerEvent): void;
  up(p: Point, e: PointerEvent): void;
  hover?(p: Point, e: PointerEvent): void;
  /** The browser took the pointer (a scroll started): drop the gesture without acting. */
  cancel?(): void;
  /** After every pan or zoom (the editor rescales its handles). */
  viewChanged?(): void;
}

export class PlanView {
  /** The plan box: the underlay, the heatmap canvas over it, the plan SVG, and the legend. */
  readonly el: HTMLDivElement;
  readonly #svg: SVGSVGElement;
  /** The underlay drawing, a separate SVG under the heatmap canvas with the same viewBox. */
  readonly #underlaySvg: SVGSVGElement;
  readonly #heatLegend: HTMLDivElement;
  readonly #heatBox: HTMLDivElement;
  readonly #heatValues: SVGGElement;
  #heat: HeatLayer | null = null;
  #heatLayer: HeatLayerId | null = null;
  #heatLoad: Promise<HeatLayer | null> | null = null;
  #labelHeat: ((g: SVGGElement, data: LayerData | null) => void) | null = null;
  #mesh: MeshLayer | null = null;
  #meshOn = false;
  #meshLoad: Promise<MeshLayer | null> | null = null;
  /** Layers released (the element left the page): loads wait for `resume`. */
  #released = false;
  /** Bumped by `dispose`, so a layer that finishes loading after it is dropped. */
  #generation = 0;
  readonly #meshSlot: SVGGElement;
  readonly #overlay: SVGGElement;
  readonly #underlay: SVGGElement;
  readonly #body: SVGGElement;
  /** Live device markers, above the plan and below the editor's handles. */
  readonly markers = new MarkerLayer();
  #hass: Hass | undefined;
  #selectedDevice: string | null = null;
  #view: View = { x: 0, y: 0, w: 10, h: 6 };
  #plan: Plan | null = null;
  #fitted = false;
  #underlayUrl: string | null = null;
  readonly #pointers = new Map<number, { x: number; y: number }>();
  #gesture: 'pan' | 'delegate' | 'pinch' | null = null;
  #last: { x: number; y: number; d?: number } | null = null;
  #delegate: PointerDelegate | null = null;
  #onPlan: (() => void) | null = null;

  /**
   * `fixed`: the dashboard card. No pan or zoom, so the page still scrolls over it, and the plan is
   * refitted whenever the card changes size.
   */
  constructor(readonly fixed = false) {
    this.#underlay = s('g', { class: 'underlay' });
    this.#body = s('g', { class: 'body' });
    this.#overlay = s('g', { class: 'overlay' });
    this.#heatValues = s('g', { class: 'heat-values', 'aria-hidden': 'true' });
    this.#meshSlot = s('g', { class: 'mesh-slot' });
    this.#underlaySvg = s(
      'svg',
      { class: 'underlay-svg', 'aria-hidden': 'true', preserveAspectRatio: 'none' },
      this.#underlay,
    );
    this.#svg = s(
      'svg',
      // A group, not an image, so the device markers inside are buttons screen readers reach.
      { class: 'plan', role: 'group', 'aria-label': 'Floor plan', preserveAspectRatio: 'none' },
      this.#body,
      this.#meshSlot,
      this.#heatValues,
      this.markers.g,
      this.#overlay,
    );
    this.#heatBox = h('div', { class: 'heat-box', hidden: true });
    this.#heatLegend = h('div', { class: 'heat-legend', role: 'img', hidden: true });
    this.el = h(
      'div',
      { class: 'plan-box' },
      this.#underlaySvg,
      this.#heatBox,
      this.#svg,
      this.#heatLegend,
    );
    if (fixed) {
      this.#svg.classList.add('fixed');
      this.el.classList.add('fixed');
    } else this.#svg.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    this.#svg.addEventListener('pointerdown', (e) => this.#down(e));
    this.#svg.addEventListener('pointermove', (e) => this.#move(e));
    this.#svg.addEventListener('pointerup', (e) => this.#up(e));
    this.#svg.addEventListener('pointercancel', (e) => this.#up(e, true));
    this.#svg.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.#resize()).observe(this.#svg);
  }

  /** The live heatmap, once a layer has been switched on (loaded on demand). */
  get heat(): HeatLayer | null {
    return this.#heat;
  }

  /** Mesh links between placed devices, once the Mesh layer has been switched on. */
  get mesh(): MeshLayer | null {
    return this.#mesh;
  }

  get delegate(): PointerDelegate | null {
    return this.#delegate;
  }

  /** Hand pointer handling to `delegate` (the editor or the device controls). */
  setDelegate(delegate: PointerDelegate | null): void {
    this.#delegate = delegate;
  }

  /** Call `fn` after every setPlan (the viewer refreshes its layer buttons). */
  onPlan(fn: () => void): void {
    this.#onPlan = fn;
  }

  /** The editor's handles and drafts, drawn above everything else. */
  drawOverlay(...nodes: SVGElement[]): void {
    this.#overlay.replaceChildren(...nodes);
  }

  /** Mark the plan as edited with `tool` (for the cursor), or not edited. */
  setEditing(tool: string | null): void {
    this.#svg.classList.toggle('editing', !!tool);
    this.#svg.dataset['tool'] = tool ?? '';
  }

  get view(): View {
    return this.#view;
  }

  get plan(): Plan | null {
    return this.#plan;
  }

  /** Metres per screen pixel at the current zoom. */
  get mpp(): number {
    return metresPerPixel(this.#view, Math.max(1, this.#svg.clientWidth));
  }

  setPlan(plan: Plan | null, selected?: { kind: string; id: string } | null): void {
    this.#plan = plan;
    this.#body.innerHTML = plan ? planBody(plan) : '';
    if (selected) {
      const sel = `[data-kind="${selected.kind}"][data-id="${CSS.escape(selected.id)}"]`;
      for (const el of this.#body.querySelectorAll(sel)) el.classList.add('selected');
    }
    for (const el of this.#body.querySelectorAll('.room')) {
      const room = plan?.rooms.find((r) => r.id === (el as SVGElement).dataset['id']);
      if (room?.area_ids) el.classList.add('linked');
    }
    this.#selectedDevice = selected?.kind === 'device' ? selected.id : null;
    this.markers.render(plan?.devices ?? [], this.#hass, this.#selectedDevice);
    this.#renderUnderlay();
    if (!this.#fitted) this.fit();
    this.#heat?.setPlan(plan);
    this.#mesh?.setPlan(plan);
    this.#tidyLabels();
    this.#onPlan?.();
  }

  /** Show a heatmap layer, or none. The renderer loads the first time a layer is shown. */
  async setLayer(layer: HeatLayerId | null): Promise<void> {
    this.#heatLayer = layer;
    if (this.#released || (!layer && !this.#heat)) return;
    const heat = await this.#loadHeat();
    if (heat && heat === this.#heat) heat.setLayer(this.#heatLayer);
  }

  get layer(): HeatLayerId | null {
    return this.#heatLayer;
  }

  /** Show or hide the mesh links. Their code loads the first time they are shown. */
  async setMesh(on: boolean): Promise<void> {
    this.#meshOn = on;
    if (this.#released || (!on && !this.#mesh)) return;
    const generation = this.#generation;
    this.#meshLoad ??= import('./mesh-layer').then((m) => {
      if (generation !== this.#generation) return null;
      const mesh = new m.MeshLayer();
      this.#meshSlot.append(mesh.g);
      this.el.append(mesh.note);
      mesh.setHass(this.#hass);
      mesh.setPlan(this.#plan);
      this.#mesh = mesh;
      return mesh;
    });
    const mesh = await this.#meshLoad;
    if (mesh && mesh === this.#mesh) await mesh.setOn(this.#meshOn);
  }

  get meshOn(): boolean {
    return this.#meshOn;
  }

  #loadHeat(): Promise<HeatLayer | null> {
    const generation = this.#generation;
    this.#heatLoad ??= import('./heat-layer').then((m) => {
      if (generation !== this.#generation) return null;
      const heat = new m.HeatLayer(this.#heatBox, this.#heatLegend);
      this.#labelHeat = m.renderValueLabels;
      this.#declutter = m.declutterLabels;
      heat.onReadings = (data) => this.#markHeat(data);
      heat.setView(this.#view, this.#svg.clientWidth, this.#svg.clientHeight);
      heat.setHass(this.#hass);
      heat.setPlan(this.#plan);
      this.#heat = heat;
      return heat;
    });
    return this.#heatLoad;
  }

  /**
   * Release the heatmap and mesh layers (worker, WebGL context, refresh timer) when the element
   * leaves the page. The chosen layer and mesh switch are kept: `resume` builds them again.
   */
  dispose(): void {
    this.#released = true;
    this.#generation++;
    this.#heat?.dispose();
    this.#heat = null;
    this.#heatLoad = null;
    this.#mesh?.dispose();
    this.#mesh?.g.remove();
    this.#mesh?.note.remove();
    this.#mesh = null;
    this.#meshLoad = null;
  }

  /** Back on the page after `dispose`: load the layers that were on. */
  async resume(): Promise<void> {
    if (!this.#released) return;
    this.#released = false;
    await Promise.all([this.setLayer(this.#heatLayer), this.setMesh(this.#meshOn)]);
  }

  /** Value labels next to the layer's sensors; sensors left out are marked. */
  #markHeat(data: LayerData | null): void {
    this.#labelHeat?.(this.#heatValues, data);
    this.#tidyLabels();
    this.el.classList.toggle('heat-on', !!data && data.readings.length > 0);
    const used = new Set(data?.readings.map((r) => r.id));
    const left = new Set(data?.excluded.map((r) => r.id));
    for (const el of this.#body.querySelectorAll<SVGElement>('.source')) {
      const id = el.dataset['id'] ?? '';
      el.classList.toggle('heat-used', used.has(id));
      el.classList.toggle('heat-excluded', left.has(id));
    }
  }

  #declutter: ((body: SVGGElement, values: SVGGElement, mpp: number) => void) | null = null;

  /** Value labels clear of the room names (once the heatmap code has loaded). */
  #tidyLabels(): void {
    this.#declutter?.(this.#body, this.#heatValues, this.mpp);
  }

  /** New states from Home Assistant: restyle the markers whose entity changed. */
  setHass(hass: Hass | undefined): void {
    this.#hass = hass;
    this.markers.update(hass);
    this.#heat?.setHass(hass);
    this.#mesh?.setHass(hass);
  }

  /** The underlay image as a URL the browser can load (a blob URL). */
  setUnderlayUrl(url: string | null): void {
    if (url === this.#underlayUrl) return;
    if (this.#underlayUrl?.startsWith('blob:')) URL.revokeObjectURL(this.#underlayUrl);
    this.#underlayUrl = url;
    this.#renderUnderlay();
  }

  get underlayUrl(): string | null {
    return this.#underlayUrl;
  }

  /** Viewer preference: hide the underlay, or show it at another opacity than the plan's. */
  setUnderlayDisplay(display: { visible: boolean; opacity: number | null } | null): void {
    this.#display = display;
    this.#renderUnderlay();
  }

  #display: { visible: boolean; opacity: number | null } | null = null;

  #renderUnderlay(): void {
    const u = this.#plan?.underlay;
    if (!u || !this.#underlayUrl || this.#display?.visible === false) {
      this.#underlay.replaceChildren();
      this.el.classList.remove('with-underlay');
      return;
    }
    const img = s('image', {
      href: this.#underlayUrl,
      x: u.origin[0],
      y: u.origin[1],
      width: u.width_px * u.scale,
      height: u.height_px * u.scale,
      opacity: this.#display?.opacity ?? u.opacity,
      preserveAspectRatio: 'none',
    });
    this.#underlay.replaceChildren(img);
    // Rooms let the drawing show through.
    this.el.classList.add('with-underlay');
  }

  fit(): void {
    const w = this.#svg.clientWidth;
    const h = this.#svg.clientHeight;
    if (w === 0 || h === 0) {
      this.#fitted = false;
      return;
    }
    this.#fitted = true;
    this.#setView(fitView(this.#plan ? planBounds(this.#plan) : null, w / h, 0.6));
  }

  zoom(factor: number, at?: Point): void {
    const c: Point = at ?? [this.#view.x + this.#view.w / 2, this.#view.y + this.#view.h / 2];
    this.#setView(zoomAt(this.#view, c, factor));
  }

  /** Plan coordinates of a pointer event. */
  toPlan(e: { clientX: number; clientY: number }): Point {
    const r = this.#svg.getBoundingClientRect();
    return toPlan(this.#view, e.clientX - r.left, e.clientY - r.top, r.width || 1, r.height || 1);
  }

  #setView(v: View): void {
    this.#view = v;
    this.#svg.setAttribute('viewBox', viewBoxOf(v));
    this.#underlaySvg.setAttribute('viewBox', viewBoxOf(v));
    this.#svg.style.setProperty('--mpp', String(this.mpp));
    this.markers.setScale(this.mpp);
    this.#heat?.setView(v, this.#svg.clientWidth, this.#svg.clientHeight);
    this.#tidyLabels();
    this.#delegate?.viewChanged?.();
  }

  #resize(): void {
    const w = this.#svg.clientWidth;
    const h = this.#svg.clientHeight;
    if (w === 0 || h === 0) return;
    if (!this.#fitted || this.fixed) this.fit();
    else this.#setView(withAspect(this.#view, w / h));
  }

  #wheel(e: WheelEvent): void {
    e.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels as ±100-ish lines.
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.zoom(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), this.toPlan(e));
  }

  #down(e: PointerEvent): void {
    if (this.fixed) {
      if (this.#pointers.size === 0 && this.#delegate?.down(this.toPlan(e), e)) {
        this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.#gesture = 'delegate';
      }
      return;
    }
    this.#svg.setPointerCapture?.(e.pointerId);
    this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.#pointers.size === 2) {
      // A second finger turns any gesture into pinch-zoom.
      if (this.#gesture === 'delegate') this.#delegate?.up(this.toPlan(e), e);
      this.#gesture = 'pinch';
      this.#last = this.#pinchState();
      return;
    }
    if (this.#pointers.size > 2) return;
    const panButton = e.button === 1 || e.button === 2 || e.shiftKey;
    if (!panButton && this.#delegate?.down(this.toPlan(e), e)) {
      this.#gesture = 'delegate';
      return;
    }
    this.#gesture = 'pan';
    this.#last = { x: e.clientX, y: e.clientY };
    this.#svg.classList.add('panning');
  }

  #pinchState(): { x: number; y: number; d: number } {
    const [a, b] = [...this.#pointers.values()];
    return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  }

  #move(e: PointerEvent): void {
    if (this.#pointers.has(e.pointerId))
      this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.#gesture === 'delegate') {
      this.#delegate?.move(this.toPlan(e), e);
    } else if (this.#gesture === 'pan' && this.#last) {
      const k = this.mpp;
      this.#setView(
        panBy(this.#view, -(e.clientX - this.#last.x) * k, -(e.clientY - this.#last.y) * k),
      );
      this.#last = { x: e.clientX, y: e.clientY };
    } else if (this.#gesture === 'pinch' && this.#last && this.#pointers.size === 2) {
      const now = this.#pinchState();
      const k = this.mpp;
      let v = panBy(this.#view, -(now.x - this.#last.x) * k, -(now.y - this.#last.y) * k);
      if (this.#last.d && now.d > 0) {
        this.#view = v;
        v = zoomAt(v, this.toPlan({ clientX: now.x, clientY: now.y }), now.d / this.#last.d);
      }
      this.#setView(v);
      this.#last = now;
    } else if (this.#gesture === null) {
      this.#delegate?.hover?.(this.toPlan(e), e);
    }
  }

  #up(e: PointerEvent, cancelled = false): void {
    if (!this.#pointers.delete(e.pointerId) && this.fixed) return;
    if (this.#gesture === 'delegate') {
      if (cancelled && this.#delegate?.cancel) this.#delegate.cancel();
      else this.#delegate?.up(this.toPlan(e), e);
    }
    if (this.#pointers.size === 0) {
      this.#gesture = null;
      this.#last = null;
      this.#svg.classList.remove('panning');
    } else if (this.#gesture === 'pinch') {
      // One finger left: carry on panning with it.
      this.#gesture = 'pan';
      const [p] = [...this.#pointers.values()];
      this.#last = { x: p!.x, y: p!.y };
    }
  }
}

/** CSS for the plan inside the panel's shadow root, using Home Assistant theme colours. */
export const planViewStyles = `
  .plan-box { position: relative; width: 100%; height: 100%; overflow: hidden;
    background: var(--primary-background-color, #fafafa); }
  .plan-box.fixed { background: none; }
  .plan-box.hidden { visibility: hidden; }
  svg.plan { position: relative; display: block; width: 100%; height: 100%; touch-action: none; user-select: none;
    background: none; cursor: grab; }
  svg.plan.panning { cursor: grabbing; }
  svg.plan.fixed { touch-action: pan-x pan-y; cursor: default; background: none; }
  .room { fill: var(--card-background-color, #fff); stroke: var(--divider-color, #ddd); stroke-width: 1px; vector-effect: non-scaling-stroke; }
  .with-underlay .room { fill-opacity: 0.35; }
  .room.linked { fill: color-mix(in srgb, var(--primary-color, #03a9f4) 6%, var(--card-background-color, #fff)); }
  .wall { stroke: none; fill: var(--secondary-text-color, #777); }
  .wall.exterior { fill: var(--primary-text-color, #333); }
  .window { fill: var(--card-background-color, #fff); stroke: var(--primary-text-color, #333); stroke-width: 1px; vector-effect: non-scaling-stroke; }
  .door { fill: none; stroke: var(--primary-text-color, #333); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .swing { fill: none; stroke: var(--secondary-text-color, #999); stroke-width: 1px; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
  .name { font-size: 0.32px; fill: var(--primary-text-color, #222); text-anchor: middle; pointer-events: none; }
  .area { font-size: 0.24px; fill: var(--secondary-text-color, #666); text-anchor: middle; pointer-events: none; }
  .source { fill: var(--primary-color, #03a9f4); stroke: #fff; stroke-width: 1px; vector-effect: non-scaling-stroke; }
  .source.access_point { fill: var(--orange-color, #ff9800); }
  .source.radio { fill: var(--purple-color, #9c27b0); }
  .source.selected { stroke: var(--primary-text-color, #222); stroke-width: 3px; }
  .selected.wall, .selected.window { fill: var(--primary-color, #03a9f4); }
  .selected.room { fill: color-mix(in srgb, var(--primary-color, #03a9f4) 18%, transparent); stroke: var(--primary-color, #03a9f4); stroke-width: 2px; }
  .selected .door, .selected .swing { stroke: var(--primary-color, #03a9f4); }
  .underlay-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .heat-box { position: absolute; inset: 0; pointer-events: none; }
  .heat-box canvas { display: block; width: 100%; height: 100%; }
  .heat-on .room, .heat-on .room.linked { fill: var(--card-background-color, #fff); fill-opacity: 0.14; }
  .heat-on .name, .heat-on .area, .heat-value { paint-order: stroke; stroke-linejoin: round;
    stroke: color-mix(in srgb, var(--card-background-color, #fff) 80%, transparent); stroke-width: calc(var(--mpp, 0.01) * 3px); }
  .heat-on .name, .heat-on .area { stroke-width: 0.06px; }
  .heat-value { font-size: calc(var(--mpp, 0.01) * 12px); font-weight: 600; fill: var(--primary-text-color, #222);
    text-anchor: middle; pointer-events: none; }
  .heat-value { transform: translateY(calc(var(--mpp, 0.01) * -10px)); }
  .heat-value.below { transform: translateY(calc(var(--mpp, 0.01) * 22px)); }
  .heat-value.crowded, .area.crowded { display: none; }
  .heat-value.excluded { fill: var(--secondary-text-color, #777); pointer-events: auto; }
  .source.heat-excluded { fill: none; stroke: var(--secondary-text-color, #777); stroke-width: 1.5px; stroke-dasharray: 2 2; }
  .heat-legend { position: absolute; top: 10px; right: 10px; width: 190px; box-sizing: border-box; padding: 6px 10px 8px;
    border-radius: 8px; font-size: 12px; line-height: 1.3; color: var(--primary-text-color, #222); pointer-events: none;
    background: color-mix(in srgb, var(--card-background-color, #fff) 90%, transparent);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
  .fixed .heat-legend, .plan-box.fixed .heat-legend { top: auto; bottom: 4px; right: 4px; width: 160px; font-size: 11px; }
  .heat-title { font-weight: 600; margin-bottom: 4px; }
  .heat-title span { font-weight: 400; color: var(--secondary-text-color, #666); }
  .heat-bar { position: relative; height: 10px; border-radius: 3px; }
  .heat-tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--primary-text-color, #222);
    box-shadow: 0 0 0 1px var(--card-background-color, #fff); }
  .heat-scale { display: flex; justify-content: space-between; color: var(--secondary-text-color, #666); margin-top: 2px; }
  .heat-note { color: var(--secondary-text-color, #666); margin-top: 2px; }
  .mesh[hidden] { display: none; }
  .mesh-link { stroke-width: 2.5px; vector-effect: non-scaling-stroke; stroke-linecap: round; opacity: 0.85; pointer-events: stroke; }
  .mesh-link.unknown { stroke-dasharray: 4 4; }
  .mesh-note { position: absolute; left: 8px; bottom: 8px; max-width: 60%; font-size: 11px; padding: 2px 6px; border-radius: 4px;
    background: var(--card-background-color, #fff); opacity: 0.9; color: var(--secondary-text-color, #555); }
  .mesh-note[hidden] { display: none; }
  .heat-layers { display: flex; gap: 4px; }
${markerStyles}`;
