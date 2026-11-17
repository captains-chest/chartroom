// Device markers as SVG: a disc with a glyph, a constant size on screen whatever the zoom, and
// classes for the state (active, unavailable…) that the styles below colour.
import { itemPrimary } from './device-entities';
import type { Hass } from './ha-types';
import { deviceLook, GLYPHS } from './devices';
import type { Device, Plan } from './plan/models';
import { s } from './ui';

/** A marker on the page: the item it shows, and the entity (of the item's device) it shows. */
interface Marker {
  el: SVGGElement;
  glyph: SVGElement;
  device: Device;
  entity: string;
  state: unknown;
}

/** Marker radius on screen, in pixels. */
export const MARKER_PX = 13;
/** The selection/pending ring sits this far outside the disc (px). */
const RING_GAP_PX = 3;
/** How long a tap shows as pending when Home Assistant reports no state change. */
const PENDING_TIMEOUT_MS = 10_000;
/** Glyph size on screen (px); GLYPHS are drawn on a 24-unit grid, centred on the marker. */
const GLYPH_PX = 18;
const GLYPH_TRANSFORM = `translate(${-GLYPH_PX / 2} ${-GLYPH_PX / 2}) scale(${GLYPH_PX / 24})`;

export class MarkerLayer {
  readonly g: SVGGElement;
  #els = new Map<string, Marker>();
  #mpp = 0.01;
  #selected: string | null = null;
  #plan: Plan | null = null;

  constructor() {
    this.g = s('g', { class: 'devices' });
  }

  /** Draw `plan`'s devices; reuses markers whose item did not change and only restyles them. */
  render(plan: Plan | null, hass: Hass | undefined, selected: string | null = null): void {
    this.#selected = selected;
    this.#plan = plan;
    const next = new Map<string, Marker>();
    const order: SVGGElement[] = [];
    for (const d of plan?.devices ?? []) {
      let m = this.#els.get(d.id);
      if (!m || m.device.entity_id !== d.entity_id || m.device.device_id !== d.device_id) {
        m = { ...this.#create(d), device: d, entity: d.entity_id, state: undefined };
      }
      m.device = d;
      this.#place(m.el, d);
      this.#style(m, hass);
      next.set(d.id, m);
      order.push(m.el);
    }
    this.#els = next;
    // Only touch the DOM when the set or order changed, so focus survives state updates.
    const cur = [...this.g.children];
    if (cur.length !== order.length || cur.some((el, i) => el !== order[i]))
      this.g.replaceChildren(...order);
  }

  /** Restyle markers whose state object changed (hass updates on every state change anywhere). */
  update(hass: Hass | undefined): void {
    for (const m of this.#els.values()) this.#style(m, hass);
  }

  /** Keep markers the same size on screen. */
  setScale(mpp: number): void {
    this.#mpp = mpp;
    for (const m of this.#els.values()) this.#place(m.el, m.device);
  }

  /** Show that a tap is waiting for Home Assistant (cleared by the state change, or after 10 s). */
  markPending(id: string): void {
    const el = this.#els.get(id)?.el;
    if (!el) return;
    el.classList.add('pending');
    setTimeout(() => el.classList.remove('pending'), PENDING_TIMEOUT_MS);
  }

  #create(d: Device): Pick<Marker, 'el' | 'glyph'> {
    const glyph = s('path', { class: 'glyph', transform: GLYPH_TRANSFORM });
    const el = s(
      'g',
      {
        class: 'device',
        'data-kind': 'device',
        'data-id': d.id,
        'data-entity': d.entity_id,
        role: 'button',
        tabindex: 0,
      },
      s('circle', { class: 'ring', r: MARKER_PX + RING_GAP_PX }),
      s('circle', { class: 'disc', r: MARKER_PX }),
      glyph,
      s('path', { class: 'slash', d: 'M-8 8L8 -8' }),
    );
    return { el, glyph };
  }

  #place(el: SVGGElement, d: Device): void {
    el.setAttribute(
      'transform',
      `translate(${d.position[0]} ${d.position[1]}) scale(${this.#mpp})`,
    );
  }

  #style(m: Marker, hass: Hass | undefined): void {
    const entity = this.#plan ? itemPrimary(this.#plan, hass, m.device) : m.device.entity_id;
    const st = hass?.states?.[entity];
    const sel = this.#selected === m.device.id;
    const key = `${entity}|${st?.state}|${st?.attributes.friendly_name}|${st?.attributes.device_class}|${sel}`;
    if (m.state === st && m.el.dataset['key'] === key) return;
    const changed = m.state !== st || m.entity !== entity;
    m.state = st;
    m.entity = entity;
    m.el.dataset['key'] = key;
    m.el.dataset['entity'] = entity;
    const look = deviceLook(entity, st);
    const el = m.el;
    // A tap waits for HA: the pending ring clears on the entity's next state change.
    const pending = el.classList.contains('pending') && !changed;
    el.setAttribute('class', `device g-${look.glyph} s-${look.status}`);
    el.classList.toggle('active', look.active);
    el.classList.toggle(
      'off',
      !look.active && look.status !== 'unavailable' && look.status !== 'unknown',
    );
    el.classList.toggle('selected', sel);
    el.classList.toggle('pending', pending);
    el.dataset['status'] = look.status;
    // No <title>: its native tooltip would cover the popover (device-popover.ts), which the
    // marker names with aria-describedby while it shows.
    el.setAttribute('aria-label', look.label);
    m.glyph.setAttribute('d', GLYPHS[look.glyph]);
  }
}

/** Marker colours from Home Assistant's theme variables, with fallbacks. */
export const markerStyles = `
  .device { cursor: pointer; outline: none; }
  .device .disc { fill: var(--card-background-color, #fff); stroke: var(--secondary-text-color, #727272); stroke-width: 1.5; }
  .device .ring { fill: none; stroke: none; stroke-width: 2.5; }
  .device .glyph { fill: none; stroke: var(--secondary-text-color, #727272); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .device .slash { display: none; stroke: var(--error-color, #db4437); stroke-width: 2.5; stroke-linecap: round; }
  .device.active { --on: var(--state-active-color, var(--amber-color, #ffc107)); }
  .device.active.g-door, .device.active.g-window, .device.active.g-garage { --on: var(--state-binary_sensor-door-on-color, var(--deep-orange-color, #ff5722)); }
  .device.active.g-motion, .device.active.g-sensor { --on: var(--state-binary_sensor-active-color, var(--blue-color, #2196f3)); }
  .device.active.g-cover { --on: var(--state-cover-active-color, var(--purple-color, #9c27b0)); }
  .device.active.g-lock { --on: var(--state-lock-unlocked-color, var(--red-color, #f44336)); }
  .device.active .disc { fill: var(--on); stroke: var(--on); }
  .device.active .glyph { stroke: #fff; }
  .device.s-locked .disc { stroke: var(--state-lock-locked-color, var(--green-color, #4caf50)); }
  .device.s-locked .glyph { stroke: var(--state-lock-locked-color, var(--green-color, #4caf50)); }
  .device.s-unavailable .disc, .device.s-unknown .disc { stroke-dasharray: 3 3; fill: var(--secondary-background-color, #eee); }
  .device.s-unavailable { opacity: 0.75; }
  .device.s-unavailable .glyph, .device.s-unknown .glyph { stroke: var(--disabled-text-color, #9e9e9e); }
  .device.s-unavailable .slash { display: inline; }
  .device.pending .ring { stroke: var(--primary-color, #03a9f4); stroke-dasharray: 4 4; }
  .device:focus-visible .ring, .device.selected .ring { stroke: var(--primary-color, #03a9f4); }
  /* While scrubbing history, states change in quick steps: let the colours fade between them. */
  :host([history]) .device :is(.disc, .glyph) { transition: fill 0.25s, stroke 0.25s; }
  @media (prefers-reduced-motion: reduce) { :host([history]) .device :is(.disc, .glyph) { transition: none; } }
`;
