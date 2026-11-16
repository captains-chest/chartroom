// The selected device marker: which entity it shows.
import { deviceChoices, deviceLook } from '../../devices';
import { entityArea } from '../../model';
import type { Device } from '../../plan/models';
import { updateDevice } from '../../plan/ops';
import { field, h, select } from '../../ui';
import type { Fields, PanelContext } from './context';

export function deviceFields(ctx: PanelContext, dev: Device): Fields {
  const { id } = dev;
  const hass = ctx.hass;
  const placed = new Set((ctx.plan.devices ?? []).map((d) => d.entity_id));
  const opts = deviceChoices(ctx.hass, ctx.plan.floor_id ?? null)
    .filter((c) => c.entity_id === dev.entity_id || !placed.has(c.entity_id))
    .map((c) => ({ value: c.entity_id, label: c.name }));
  if (!opts.some((o) => o.value === dev.entity_id))
    opts.unshift({ value: dev.entity_id, label: `${dev.entity_id} (not on this floor)` });
  const area = hass ? entityArea(hass, dev.entity_id) : null;
  const look = deviceLook(dev.entity_id, hass?.states?.[dev.entity_id]);
  return [
    field(
      'Entity',
      select(opts, dev.entity_id, (v) => ctx.commit(updateDevice(ctx.plan, id, v)), {
        name: 'entity',
      }),
    ),
    h(
      'p',
      { class: 'meta', 'data-entity': dev.entity_id },
      `${look.label} · ${area ? (hass?.areas?.[area]?.name ?? area) : 'No area'} · ${dev.position[0].toFixed(2)}, ${dev.position[1].toFixed(2)} m`,
    ),
  ];
}
