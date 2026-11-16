// The plan itself: name, floor, and what it holds.
import { polygonArea } from '../../geometry';
import { field, h, select, textInput } from '../../ui';
import { type PanelContext, section } from './context';

export function planPanel(ctx: PanelContext): HTMLElement {
  const plan = ctx.plan;
  const floors = Object.values(ctx.hass?.floors ?? {});
  const area = plan.rooms.reduce((sum, r) => sum + polygonArea(r.polygon), 0);
  return section(
    'Plan',
    'plan',
    field(
      'Name',
      textInput(plan.name, (v) => v.trim() && ctx.commit({ ...plan, name: v.trim() }), {
        name: 'plan-name',
      }),
    ),
    field(
      'Floor',
      select(
        [
          { value: '', label: '— none —' },
          ...floors.map((f) => ({ value: f.floor_id, label: f.name })),
        ],
        plan.floor_id ?? '',
        (v) => ctx.commit({ ...ctx.plan, floor_id: v || null }),
        { name: 'floor' },
      ),
    ),
    h(
      'p',
      { class: 'meta' },
      `${plan.walls.length} walls · ${plan.rooms.length} rooms · ${plan.doors.length} doors · ${plan.windows.length} windows · ${plan.sources.length} sources · ${plan.devices?.length ?? 0} devices · ${area.toFixed(1)} m²`,
    ),
  );
}
