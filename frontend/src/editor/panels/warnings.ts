// The plan's soft limits, when it is over them.
import { limitWarnings } from '../../plan/functions';
import type { Plan } from '../../plan/models';
import { signalLimitWarnings } from '../../signal';
import { h } from '../../ui';

export function warningsPanel(plan: Plan): HTMLElement | null {
  const warnings = [...limitWarnings(plan), ...signalLimitWarnings(plan)];
  if (warnings.length === 0) return null;
  return h(
    'section',
    { 'data-panel': 'warnings', class: 'warnings', role: 'status' },
    ...warnings.map((w) => h('p', {}, w)),
  );
}
