// The plan as live SVG: underlay image, the plan body, and an overlay group the editor draws
// handles into. Handles pan (drag), zoom (wheel, pinch, buttons) and keeps the viewBox in metres.
import { planBounds } from './geometry';
import type { Plan, Point } from './plan';
import { planBody } from './plan-svg';
import { s } from './ui';
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
}

export class PlanView {
  readonly svg: SVGSVGElement;
  readonly overlay: SVGGElement;
  readonly #underlay: SVGGElement;
  readonly #body: SVGGElement;
  #view: View = { x: 0, y: 0, w: 10, h: 6 };
  #plan: Plan | null = null;
  #fitted = false;
  #underlayUrl: string | null = null;
  #pointers = new Map<number, { x: number; y: number }>();
  #gesture: 'pan' | 'delegate' | 'pinch' | null = null;
  #last: { x: number; y: number; d?: number } | null = null;
  delegate: PointerDelegate | null = null;
  /** Called after every pan or zoom (the editor rescales its handles). */
  onViewChange: (() => void) | null = null;

  constructor() {
    this.#underlay = s('g', { class: 'underlay' });
    this.#body = s('g', { class: 'body' });
    this.overlay = s('g', { class: 'overlay' });
    this.svg = s(
      'svg',
      { class: 'plan', role: 'img', 'aria-label': 'Floor plan', preserveAspectRatio: 'none' },
      this.#underlay,
      this.#body,
      this.overlay,
    );
    this.svg.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    this.svg.addEventListener('pointerdown', (e) => this.#down(e));
    this.svg.addEventListener('pointermove', (e) => this.#move(e));
    this.svg.addEventListener('pointerup', (e) => this.#up(e));
    this.svg.addEventListener('pointercancel', (e) => this.#up(e));
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.#resize()).observe(this.svg);
  }

  get view(): View {
    return this.#view;
  }

  get plan(): Plan | null {
    return this.#plan;
  }

  /** Metres per screen pixel at the current zoom. */
  get mpp(): number {
    return metresPerPixel(this.#view, Math.max(1, this.svg.clientWidth));
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
      if (room?.area_id) el.classList.add('linked');
    }
    this.#renderUnderlay();
    if (!this.#fitted) this.fit();
  }

  /** The underlay image as a URL the browser can load (a blob URL from the editor). */
  setUnderlayUrl(url: string | null): void {
    this.#underlayUrl = url;
    this.#renderUnderlay();
  }

  #renderUnderlay(): void {
    const u = this.#plan?.underlay;
    if (!u || !this.#underlayUrl) {
      this.#underlay.replaceChildren();
      return;
    }
    const img = s('image', {
      href: this.#underlayUrl,
      x: u.origin[0],
      y: u.origin[1],
      width: u.width_px * u.scale,
      height: u.height_px * u.scale,
      opacity: u.opacity,
      preserveAspectRatio: 'none',
    });
    this.#underlay.replaceChildren(img);
  }

  fit(): void {
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
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
    const r = this.svg.getBoundingClientRect();
    return toPlan(this.#view, e.clientX - r.left, e.clientY - r.top, r.width || 1, r.height || 1);
  }

  #setView(v: View): void {
    this.#view = v;
    this.svg.setAttribute('viewBox', viewBoxOf(v));
    this.svg.style.setProperty('--mpp', String(this.mpp));
    this.onViewChange?.();
  }

  #resize(): void {
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    if (w === 0 || h === 0) return;
    if (!this.#fitted) this.fit();
    else this.#setView(withAspect(this.#view, w / h));
  }

  #wheel(e: WheelEvent): void {
    e.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels as ±100-ish lines.
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.zoom(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), this.toPlan(e));
  }

  #down(e: PointerEvent): void {
    this.svg.setPointerCapture?.(e.pointerId);
    this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.#pointers.size === 2) {
      // A second finger turns any gesture into pinch-zoom.
      if (this.#gesture === 'delegate') this.delegate?.up(this.toPlan(e), e);
      this.#gesture = 'pinch';
      this.#last = this.#pinchState();
      return;
    }
    if (this.#pointers.size > 2) return;
    const panButton = e.button === 1 || e.button === 2 || e.shiftKey;
    if (!panButton && this.delegate?.down(this.toPlan(e), e)) {
      this.#gesture = 'delegate';
      return;
    }
    this.#gesture = 'pan';
    this.#last = { x: e.clientX, y: e.clientY };
    this.svg.classList.add('panning');
  }

  #pinchState(): { x: number; y: number; d: number } {
    const [a, b] = [...this.#pointers.values()];
    return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  }

  #move(e: PointerEvent): void {
    if (this.#pointers.has(e.pointerId))
      this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.#gesture === 'delegate') {
      this.delegate?.move(this.toPlan(e), e);
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
      this.delegate?.hover?.(this.toPlan(e), e);
    }
  }

  #up(e: PointerEvent): void {
    this.#pointers.delete(e.pointerId);
    if (this.#gesture === 'delegate') this.delegate?.up(this.toPlan(e), e);
    if (this.#pointers.size === 0) {
      this.#gesture = null;
      this.#last = null;
      this.svg.classList.remove('panning');
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
  svg.plan { display: block; width: 100%; height: 100%; touch-action: none; user-select: none;
    background: var(--primary-background-color, #fafafa); cursor: grab; }
  svg.plan.panning { cursor: grabbing; }
  .room { fill: var(--card-background-color, #fff); stroke: var(--divider-color, #ddd); stroke-width: 1px; vector-effect: non-scaling-stroke; }
  .room.linked { fill: color-mix(in srgb, var(--primary-color, #03a9f4) 6%, var(--card-background-color, #fff)); }
  .wall { stroke: none; fill: var(--secondary-text-color, #777); }
  .wall.exterior { fill: var(--primary-text-color, #333); }
  .window { fill: var(--card-background-color, #fff); stroke: var(--primary-text-color, #333); stroke-width: 1px; vector-effect: non-scaling-stroke; }
  .door { fill: none; stroke: var(--primary-text-color, #333); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .swing { fill: none; stroke: var(--secondary-text-color, #999); stroke-width: 1px; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
  .name { font-size: 0.32px; fill: var(--primary-text-color, #222); text-anchor: middle; pointer-events: none; }
  .area { font-size: 0.24px; fill: var(--secondary-text-color, #666); text-anchor: middle; pointer-events: none; }
  .source { fill: var(--primary-color, #03a9f4); stroke: #fff; stroke-width: 1px; vector-effect: non-scaling-stroke; }
  .selected.wall, .selected.window { fill: var(--primary-color, #03a9f4); }
  .selected.room { fill: color-mix(in srgb, var(--primary-color, #03a9f4) 18%, transparent); stroke: var(--primary-color, #03a9f4); stroke-width: 2px; }
  .selected .door, .selected .swing { stroke: var(--primary-color, #03a9f4); }
  .underlay { pointer-events: none; }
`;
