// The selected device marker: which device it shows, and which of the device's entities it leaves
// out.
import { entitiesOfDevice, itemPrimary } from '../../device-entities';
import {
  type DeviceChoice,
  deviceChoices,
  deviceLook,
  deviceName,
  entityName,
  isPlaced,
} from '../../devices';
import { entityArea } from '../../model';
import type { Device } from '../../plan/models';
import { setDeviceExclude, updateDevice } from '../../plan/ops';
import { field, h, select } from '../../ui';
import type { Fields, PanelContext } from './context';

/**
 * The device's entities, a checkbox each (checked: the item stands for it). The entity it is
 * placed by stays checked; one placed as an item of its own is that item's and not listed.
 * Nothing for an item without a device, or a device with one entity.
 */
function entitiesField(ctx: PanelContext, dev: Device): HTMLElement | null {
  const hass = ctx.hass;
  if (!dev.device_id) return null;
  const own = new Set((ctx.plan.devices ?? []).filter((d) => !d.device_id).map((d) => d.entity_id));
  const all = entitiesOfDevice(hass, dev.device_id).filter((e) => !own.has(e));
  if (all.length < 2) return null;
  const name = deviceName(dev.entity_id, dev.device_id, hass);
  const out = new Set(dev.exclude);
  const toggle = (entity: string, include: boolean): void => {
    const now = ctx.plan.devices?.find((d) => d.id === dev.id);
    if (!now) return;
    // Entities no longer the device's go with any change.
    const kept = (now.exclude ?? []).filter((e) => e !== entity && all.includes(e));
    ctx.commit(setDeviceExclude(ctx.plan, dev.id, include ? kept : [...kept, entity]));
  };
  const rows = all.map((entity) => {
    const box = h('input', {
      type: 'checkbox',
      name: 'include',
      value: entity,
      'data-entity-id': entity,
      checked: !out.has(entity),
      disabled: entity === dev.entity_id,
      title: entity === dev.entity_id ? 'The entity it is placed by' : entity,
    });
    box.addEventListener('change', () => toggle(entity, box.checked));
    return h('label', { class: 'check' }, box, entityName(entity, name, hass));
  });
  return h(
    'div',
    { class: 'field', role: 'group', 'aria-label': 'Entities shown', 'data-field': 'entities' },
    h('span', {}, 'Entities shown'),
    h('div', { class: 'checks' }, ...rows),
  );
}

export function deviceFields(ctx: PanelContext, dev: Device): Fields {
  const { id } = dev;
  const hass = ctx.hass;
  const devices = ctx.plan.devices ?? [];
  const choices = deviceChoices(ctx.hass, ctx.plan.floor_id ?? null);
  const own = (c: DeviceChoice): boolean =>
    dev.device_id ? c.device_id === dev.device_id : c.entity_id === dev.entity_id;
  const current = choices.find(own);
  const opts = choices
    .filter((c) => own(c) || !isPlaced(devices, c))
    .map((c) => ({ value: c.entity_id, label: c.name }));
  if (!current)
    opts.unshift({ value: dev.entity_id, label: `${dev.entity_id} (not on this floor)` });
  const entity = ctx.plan ? itemPrimary(ctx.plan, hass, dev) : dev.entity_id;
  const area = hass ? entityArea(hass, entity) : null;
  const look = deviceLook(entity, hass?.states?.[entity]);
  const pick = (v: string): void => {
    const c = choices.find((x) => x.entity_id === v);
    ctx.commit(updateDevice(ctx.plan, id, v, c?.device_id ?? null));
  };
  return [
    field('Device', select(opts, current?.entity_id ?? dev.entity_id, pick, { name: 'entity' })),
    h(
      'p',
      { class: 'meta', 'data-entity': entity },
      `${look.label} · ${area ? (hass?.areas?.[area]?.name ?? area) : 'No area'} · ${dev.position[0].toFixed(2)}, ${dev.position[1].toFixed(2)} m`,
    ),
    entitiesField(ctx, dev),
  ];
}
