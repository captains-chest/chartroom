// The loss per centimetre of each wall material, for the signal map.
import { materialsOf } from '../../plan/functions';
import { setMaterial } from '../../plan/ops';
import { h, numberInput } from '../../ui';
import { type PanelContext, section } from './context';

export function materialsPanel(ctx: PanelContext): HTMLElement {
  const rows = [...materialsOf(ctx.plan).values()].map((m) =>
    h(
      'tr',
      {},
      h('td', {}, m.name),
      h(
        'td',
        {},
        numberInput(m.db_per_cm, (v) => ctx.commit(setMaterial(ctx.plan, { ...m, db_per_cm: v })), {
          name: `loss-${m.id}`,
          min: 0,
          step: 0.05,
          'aria-label': `${m.name} loss in dB per cm`,
        }),
      ),
    ),
  );
  return section(
    'Materials',
    'materials',
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Material'), h('th', {}, 'dB/cm'))),
      h('tbody', {}, ...rows),
    ),
  );
}
