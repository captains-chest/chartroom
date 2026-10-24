// Device markers as SVG: a disc with a glyph, a constant size on screen whatever the zoom, and
// classes for the state (active, unavailable…) that the styles below colour.
import type { Hass } from './ha-types';
import { deviceLook, type Glyph } from './devices';
import type { Device } from './plan';
import { s } from './ui';

/** Our own line glyphs on a 24-unit grid (no icon library). */
const GLYPHS: Record<Glyph, string> = {
  light: 'M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3zM9.5 19h5M10.5 21.5h3',
  switch: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7zM16 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  fan: 'M12 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3zM12 10.5C11 6 12 3 15 3.5s1 5-3 7zM13.5 12.5c4.5-1 7.5 0 7 3s-5 1-7-3zM10.5 12.5c-3 3.5-6 4.5-7.5 2s2.5-4.5 7.5-2z',
  toggle: 'M5 5h14v14H5zM9 12l2 2 4-4',
  cover: 'M4 4h16M6 4v12h12V4M6 8h12M6 12h12M12 16v4',
  lock: 'M8 11V8a4 4 0 0 1 8 0v3M6 11h12v10H6zM12 15v2',
  door: 'M6 21V3h12v18M3 21h18M14.5 12h.5',
  window: 'M5 4h14v16H5zM12 4v16M5 12h14',
  garage: 'M3 21V9l9-5 9 5v12M7 21v-9h10v9M7 15h10M7 18h10',
  motion:
    'M13.5 3.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3zM9 21l2.5-6 2.5 2.5V21M7 12l3-3.5 3.5 1.5 2 3h2.5M11.5 15l1-6',
  sensor: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
};

/** Marker radius on screen, in pixels. */
export const MARKER_PX = 13;

export class MarkerLayer {
  readonly g: SVGGElement;
  #els = new Map<string, { el: SVGGElement; device: Device; state: unknown }>();
  #mpp = 0.01;
  #selected: string | null = null;

  constructor() {
    this.g = s('g', { class: 'devices' });
  }

  /** Draw `devices`; reuses markers whose device did not change and only restyles them. */
  render(devices: readonly Device[], hass: Hass | undefined, selected: string | null = null): void {
    this.#selected = selected;
    const next = new Map<string, { el: SVGGElement; device: Device; state: unknown }>();
    const order: SVGGElement[] = [];
    for (const d of devices) {
      let m = this.#els.get(d.id);
      if (!m || m.device.entity_id !== d.entity_id) {
        m = { el: this.#create(d), device: d, state: undefined };
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

  element(id: string): SVGGElement | undefined {
    return this.#els.get(id)?.el;
  }

  /** Show that a tap is waiting for Home Assistant (cleared by the state change, or after 10 s). */
  markPending(id: string): void {
    const el = this.#els.get(id)?.el;
    if (!el) return;
    el.classList.add('pending');
    setTimeout(() => el.classList.remove('pending'), 10_000);
  }

  #create(d: Device): SVGGElement {
    return s(
      'g',
      {
        class: 'device',
        'data-kind': 'device',
        'data-id': d.id,
        'data-entity': d.entity_id,
        role: 'button',
        tabindex: 0,
      },
      s('circle', { class: 'ring', r: MARKER_PX + 3 }),
      s('circle', { class: 'disc', r: MARKER_PX }),
      s('path', { class: 'glyph', transform: 'translate(-9 -9) scale(0.75)' }),
      s('path', { class: 'slash', d: 'M-8 8L8 -8' }),
      s('title'),
    );
  }

  #place(el: SVGGElement, d: Device): void {
    el.setAttribute(
      'transform',
      `translate(${d.position[0]} ${d.position[1]}) scale(${this.#mpp})`,
    );
  }

  #style(m: { el: SVGGElement; device: Device; state: unknown }, hass: Hass | undefined): void {
    const st = hass?.states?.[m.device.entity_id];
    const sel = this.#selected === m.device.id;
    const key = `${st?.state}|${st?.attributes.friendly_name}|${st?.attributes.device_class}|${sel}`;
    if (m.state === st && m.el.dataset['key'] === key) return;
    const changed = m.state !== st;
    m.state = st;
    m.el.dataset['key'] = key;
    const look = deviceLook(m.device.entity_id, st);
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
    el.setAttribute('aria-label', look.label);
    el.querySelector('title')!.textContent = look.label;
    el.querySelector('.glyph')!.setAttribute('d', GLYPHS[look.glyph]);
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
