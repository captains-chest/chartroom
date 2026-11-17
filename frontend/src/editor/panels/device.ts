// The selected device marker: which device it shows.
import { itemPrimary } from '../../device-entities';
import { type DeviceChoice, deviceChoices, deviceLook, isPlaced } from '../../devices';
import { entityArea } from '../../model';
import type { Device } from '../../plan/models';
import { updateDevice } from '../../plan/ops';
import { field, h, select } from '../../ui';
import type { Fields, PanelContext } from './context';

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
  ];
}
