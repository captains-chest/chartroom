// A two-point measurement, and calibrating the plan by its real distance.
import { dist, roundToMm } from '../../geometry';
import type { Point } from '../../plan/types';
import { scalePlan, twoPointFactor } from '../../plan/ops';
import { button, field, h, numberInput } from '../../ui';
import { type PanelContext, section } from './context';

export function measurePanel(
  ctx: PanelContext,
  [a, b]: readonly [Point, Point],
  /** The calibration was applied: the measurement is done. */
  done: () => void,
): HTMLElement {
  const d = dist(a, b);
  let target = d;
  return section(
    'Measure',
    'measure',
    h('p', { class: 'meta', 'data-distance': d.toFixed(3) }, `${d.toFixed(2)} m drawn`),
    field(
      'Real distance (m)',
      numberInput(roundToMm(d), (v) => (target = v), {
        name: 'real-distance',
        min: 0.01,
        step: 0.01,
      }),
    ),
    button(
      'Scale plan to match',
      () => {
        if (!(target > 0) || d === 0) return;
        done();
        ctx.commit(scalePlan(ctx.plan, twoPointFactor(a, b, target)));
      },
      { 'data-action': 'calibrate-distance', class: 'primary' },
    ),
  );
}
