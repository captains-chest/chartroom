// The popover that says which device a marker (or source) is: its name, area and one line per
// entity with its state and when it changed. Mouse and keyboard only: on touch a hold has its own
// job. `popoverContent` is the pure part; `DevicePopover` shows it next to an element of the view.
import { primaryEntity } from './device-entities';
import { deviceLook, deviceName, entityName, type Glyph } from './devices';
import type { Hass } from './ha-types';
import { GLYPHS } from './markers';
import { entityArea } from './model';
import { h, s } from './ui';

export interface PopoverLine {
  entity: string;
  glyph: Glyph;
  /** The entity's name without its device's: "Temperature". */
  name: string;
  /** "21.4 °C", "open", "unavailable". */
  value: string;
  /** "5 min ago", from `last_changed`; empty when unknown. */
  changed: string;
  unavailable: boolean;
}

export interface PopoverContent {
  title: string;
  area: string | null;
  lines: PopoverLine[];
  /** Entities left out past MAX_LINES. */
  more: number;
  /**
   * The device's mesh role and route while the Mesh layer is on, and its measured links while the
   * signal map comes from its mesh.
   */
  mesh?: string[] | undefined;
}

/** Lines shown at most; a device with more says how many are left out. */
export const MAX_LINES = 8;

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / (24 * 60))} d ago`;
}

/**
 * What the popover says for `entities` (an item's, see `itemEntities`; the marker's entity comes
 * first) of Home Assistant device `deviceId`, if any: the device's name (else the entity's), its
 * area, and a line per entity.
 */
export function popoverContent(
  entities: readonly string[],
  deviceId: string | null | undefined,
  hass: Hass | undefined,
  now = Date.now(),
): PopoverContent {
  const primary = primaryEntity(entities, hass);
  const title = deviceName(primary, deviceId, hass);
  const areaId =
    entityArea(hass, primary) ?? (deviceId && hass?.devices?.[deviceId]?.area_id) ?? null;
  const ids = [primary, ...entities.filter((e) => e !== primary)];
  const lines = ids.slice(0, MAX_LINES).map((entity): PopoverLine => {
    const st = hass?.states?.[entity];
    const look = deviceLook(entity, st);
    return {
      entity,
      glyph: look.glyph,
      // Home Assistant names an entity "<device> <name>": keep the name.
      name: entityName(entity, title, hass),
      value: look.value,
      changed: ago(st?.last_changed, now),
      unavailable: look.status === 'unavailable',
    };
  });
  return {
    title,
    area: (areaId && hass?.areas?.[areaId]?.name) || null,
    lines,
    more: ids.length - lines.length,
  };
}

/** Pixels between the anchor and the popover, and kept clear of the view's edges. */
const GAP = 8;

/** A popover anchored to an element of the plan view `box` (the positioned `.plan-box`). */
export class DevicePopover {
  readonly el: HTMLDivElement;
  #anchor: Element | null = null;
  #key = '';

  constructor(readonly box: HTMLElement) {
    this.el = h('div', {
      class: 'device-popover',
      id: 'chartroom-device-popover',
      role: 'tooltip',
      hidden: true,
    });
    box.append(this.el);
  }

  get anchor(): Element | null {
    return this.#anchor;
  }

  /** Show `content` next to `anchor`, or update it in place (same anchor, new states). */
  show(anchor: Element, content: PopoverContent): void {
    const key = JSON.stringify(content);
    if (anchor === this.#anchor && key === this.#key) return;
    if (anchor !== this.#anchor) this.#anchor?.removeAttribute('aria-describedby');
    this.#anchor = anchor;
    this.#key = key;
    anchor.setAttribute('aria-describedby', this.el.id);
    this.el.replaceChildren(
      h('div', { class: 'dp-title' }, content.title),
      content.area ? h('div', { class: 'dp-area' }, content.area) : '',
      ...(content.mesh ?? []).map((t) => h('div', { class: 'dp-mesh' }, t)),
      h(
        'ul',
        {},
        ...content.lines.map((l) =>
          h(
            'li',
            { class: l.unavailable ? 'unavailable' : null, 'data-entity': l.entity },
            s(
              'svg',
              { class: 'dp-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
              s('path', { d: GLYPHS[l.glyph] }),
            ),
            h('span', { class: 'dp-name' }, l.name),
            h('span', { class: 'dp-value' }, l.value),
            h('span', { class: 'dp-ago' }, l.changed),
          ),
        ),
        content.more > 0 ? h('li', { class: 'dp-more' }, `and ${content.more} more`) : null,
      ),
    );
    this.el.hidden = false;
    this.place();
  }

  hide(): void {
    this.#anchor?.removeAttribute('aria-describedby');
    this.#anchor = null;
    this.#key = '';
    this.el.hidden = true;
  }

  /** Beside the anchor, flipped left near the right edge; above or below when neither fits. */
  place(): void {
    const anchor = this.#anchor;
    if (!anchor) return;
    const box = this.box.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const ht = this.el.offsetHeight;
    const [l, r, t, b] = [
      a.left - box.left,
      a.right - box.left,
      a.top - box.top,
      a.bottom - box.top,
    ];
    const clamp = (v: number, size: number, max: number): number =>
      Math.max(GAP, Math.min(v, max - size - GAP));
    let x: number;
    let y: number;
    if (r + GAP + w + GAP <= box.width || l - GAP - w >= GAP) {
      x = r + GAP + w + GAP <= box.width ? r + GAP : l - GAP - w;
      y = clamp((t + b) / 2 - ht / 2, ht, box.height);
    } else {
      x = clamp((l + r) / 2 - w / 2, w, box.width);
      y = b + GAP + ht + GAP <= box.height ? b + GAP : Math.max(GAP, t - GAP - ht);
    }
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

export const devicePopoverStyles = `
  .device-popover { position: absolute; left: 0; top: 0; z-index: 2; box-sizing: border-box;
    max-width: min(300px, calc(100% - 16px)); padding: 8px 12px; border-radius: 8px;
    font-size: 13px; line-height: 1.35; pointer-events: auto;
    background: var(--card-background-color, #fff); color: var(--primary-text-color, #212121);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); }
  .device-popover[hidden], svg.plan.editing ~ .device-popover { display: none; }
  .device-popover .dp-title { font-weight: 600; }
  .device-popover .dp-mesh { font-size: 12px; }
  .device-popover .dp-area { color: var(--secondary-text-color, #727272); font-size: 12px; }
  .device-popover ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid;
    grid-template-columns: auto 1fr auto auto; gap: 2px 8px; align-items: center; }
  .device-popover li { display: contents; }
  .device-popover .dp-icon { width: 16px; height: 16px; fill: none; stroke: var(--secondary-text-color, #727272);
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .device-popover .dp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .device-popover .dp-value { font-weight: 500; white-space: nowrap; }
  .device-popover .dp-ago { color: var(--secondary-text-color, #727272); font-size: 12px; white-space: nowrap; }
  .device-popover li.unavailable :is(.dp-name, .dp-value) { color: var(--disabled-text-color, #9e9e9e); }
  .device-popover li.unavailable .dp-value { font-style: italic; }
  .device-popover .dp-more { display: block; grid-column: 1 / -1; color: var(--secondary-text-color, #727272); font-size: 12px; }
`;
