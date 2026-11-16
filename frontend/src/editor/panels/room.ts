// The selected room: name, linked Home Assistant areas, and calibrating the plan by its real area.
import { polygonArea, roundToMm } from '../../geometry';
import { areaChoices } from '../../model';
import type { Room } from '../../plan/models';
import { areaFactor, scalePlan, updateRoom } from '../../plan/ops';
import { button, field, h, numberInput, select, textInput } from '../../ui';
import { areaName, roomNameForAreas } from '../rooms';
import type { Fields, PanelContext } from './context';

/** The room's linked Home Assistant areas, each with an unlink button, and a picker to add one. */
function roomAreasField(ctx: PanelContext, room: Room): HTMLElement {
  const hass = ctx.hass;
  const linked = room.area_ids ?? [];
  const names = (ids: readonly string[]): string[] => ids.map((a) => areaName(hass, a));
  const setAreas = (ids: string[]): void => {
    const fallback = `Room ${ctx.plan.rooms.indexOf(room) + 1}`;
    const name = roomNameForAreas(room.name, names(linked), names(ids), fallback);
    ctx.commit(updateRoom(ctx.plan, room.id, { area_ids: ids, name }));
  };
  const free = areaChoices(hass, ctx.plan.floor_id ?? null).filter(
    (a) => !linked.includes(a.area_id),
  );
  const rows = linked.map((id) =>
    h(
      'div',
      { class: 'row', 'data-area-id': id },
      areaName(hass, id),
      button('×', () => setAreas(linked.filter((a) => a !== id)), {
        'data-action': 'unlink-area',
        'aria-label': `Unlink ${areaName(hass, id)}`,
      }),
    ),
  );
  const add = select(
    [
      { value: '', label: linked.length > 0 ? 'Add an area…' : '— none —' },
      ...free.map((a) => ({ value: a.area_id, label: a.name })),
    ],
    '',
    (v) => v && setAreas([...linked, v]),
    { name: 'area', 'aria-label': 'Link an area' },
  );
  return h('div', { class: 'field' }, h('span', {}, 'Home Assistant areas'), ...rows, add);
}

export function roomFields(ctx: PanelContext, room: Room): Fields {
  const { id } = room;
  const area = polygonArea(room.polygon);
  let target = area;
  return [
    field(
      'Name',
      textInput(
        room.name,
        (v) => v.trim() && ctx.commit(updateRoom(ctx.plan, id, { name: v.trim() })),
        { name: 'name' },
      ),
    ),
    roomAreasField(ctx, room),
    h('p', { class: 'meta', 'data-area': area.toFixed(2) }, `${area.toFixed(2)} m² drawn`),
    h(
      'div',
      { class: 'calibrate' },
      field(
        'Real area (m²)',
        numberInput(roundToMm(area), (v) => (target = v), {
          name: 'real-area',
          min: 0.1,
          step: 0.1,
        }),
      ),
      button(
        'Scale plan to match',
        () => {
          if (!(target > 0) || Math.abs(target - area) < 1e-6) return;
          ctx.commit(scalePlan(ctx.plan, areaFactor(room.polygon, target)));
        },
        {
          'data-action': 'calibrate-area',
          title: 'Rescale the whole drawing (and underlay) so this room has the real area',
        },
      ),
    ),
  ];
}
