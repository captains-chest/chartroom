// Plan file: export, and import over this plan (the work is in ../file-actions.ts).
import { button, field, h } from '../../ui';
import type { ExportMode } from '../file-actions';
import { type PanelContext, section } from './context';

export interface FileActions {
  /** What the last import or export said: problems (`error`) or notes. */
  readonly report: { error: boolean; lines: string[] } | null;
  exportPlan(mode: ExportMode): Promise<void>;
  importFiles(files: File[]): void;
}

/** Export the plan as a .json file, or import one (with its underlay image file) over it. */
export function filePanel(ctx: PanelContext, actions: FileActions): HTMLElement {
  const input = h('input', {
    type: 'file',
    accept: 'application/json,.json,image/png,image/jpeg,image/webp,image/svg+xml',
    multiple: true,
    name: 'plan-file',
  });
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length > 0) actions.importFiles(files);
  });
  const report = actions.report;
  return section(
    'Plan file',
    'plan-file',
    h(
      'div',
      { class: 'row' },
      button('Export', () => void actions.exportPlan('none'), { 'data-action': 'export-plan' }),
      ctx.plan.underlay
        ? button('Export with underlay', () => void actions.exportPlan('embed'), {
            'data-action': 'export-plan-underlay',
            title: 'Embed the underlay image in the .json file',
          })
        : null,
      ctx.plan.underlay
        ? button('Export with underlay file', () => void actions.exportPlan('file'), {
            'data-action': 'export-plan-underlay-file',
            title: 'Save the underlay image as its own file next to the .json',
          })
        : null,
    ),
    field('Import (replaces this plan; pick the .json and its image file)', input),
    report
      ? h(
          'div',
          {
            class: report.error ? 'file-report error' : 'file-report',
            role: report.error ? 'alert' : 'status',
          },
          ...report.lines.map((line) => h('p', {}, line)),
        )
      : null,
  );
}
