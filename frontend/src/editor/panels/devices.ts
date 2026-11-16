// The Device tool's list of entities to place: drag one onto the plan, or pick it and click.
import type { DeviceChoice } from '../../devices';
import { button, field, h } from '../../ui';
import { areaName } from '../rooms';
import { type PanelContext, section } from './context';

/** Drag-and-drop type for an entity dragged from the list onto the plan. */
export const ENTITY_MIME = 'application/x-chartroom-entity';

export interface DeviceList {
  /** The entities on offer (this floor's, when the plan has one). */
  readonly choices: readonly DeviceChoice[];
  /** The entity picked to place with the next click, if any. */
  readonly armed: string | null;
  /** What the last auto-place did. */
  readonly note: string;
  /** Pick `entity` to place, or drop the pick when it is already picked. */
  arm(entity: string): void;
  autoPlace(): void;
}

export function devicesPanel(ctx: PanelContext, offer: DeviceList): HTMLElement {
  const hass = ctx.hass;
  const placed = new Set((ctx.plan.devices ?? []).map((d) => d.entity_id));
  const free = offer.choices.filter((c) => !placed.has(c.entity_id));
  const areaOf = (a: string | null): string => (a ? areaName(hass, a) : 'No area');
  const list = h('ul', { class: 'entities', 'aria-label': 'Entities not on the plan' });
  for (const c of free) {
    const item = h(
      'li',
      {
        draggable: 'true',
        'data-entity': c.entity_id,
        'aria-pressed': String(offer.armed === c.entity_id),
        role: 'button',
        tabindex: 0,
        title: `${c.entity_id} — drag onto the plan, or click and then click the plan`,
      },
      h('span', { class: 'name' }, c.name),
      h('span', { class: 'meta' }, areaOf(c.area_id)),
    );
    const arm = (): void => offer.arm(c.entity_id);
    item.addEventListener('click', arm);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        arm();
      }
    });
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(ENTITY_MIME, c.entity_id);
      e.dataTransfer?.setData('text/plain', c.entity_id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
    list.append(item);
  }
  const filter = h('input', {
    type: 'search',
    name: 'device-filter',
    placeholder: 'Filter',
    'aria-label': 'Filter entities',
  });
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const li of list.children) {
      const el = li as HTMLElement;
      el.hidden =
        q !== '' &&
        !el.textContent!.toLowerCase().includes(`${q}`) &&
        !el.dataset['entity']!.includes(q);
    }
  });
  return section(
    'Devices',
    'devices',
    h(
      'p',
      { class: 'meta' },
      `${placed.size} on the plan · ${free.length} to place${ctx.plan.floor_id ? ' on this floor' : ''}`,
    ),
    button('Auto-place by area', () => offer.autoPlace(), { 'data-action': 'auto-place' }),
    offer.note ? h('p', { class: 'hint', role: 'status' }, offer.note) : null,
    free.length > 0 ? field('Entities', filter) : null,
    free.length > 0
      ? list
      : h(
          'p',
          { class: 'hint' },
          'Every light, switch, door, window, motion sensor, fan, cover and lock here is on the plan.',
        ),
  );
}
