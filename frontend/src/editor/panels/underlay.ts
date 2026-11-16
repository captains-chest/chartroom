// The underlay image: import or replace it, its opacity, removing it.
import { button, field, h } from '../../ui';
import { type PanelContext, section } from './context';

export function underlayPanel(
  ctx: PanelContext,
  /** The stored underlay was dropped on load for pointing outside Chartroom. */
  ignored: boolean,
  importImage: (file: File) => void,
): HTMLElement {
  const u = ctx.plan.underlay;
  const input = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
    name: 'underlay',
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) importImage(file);
  });
  const opacity = h('input', {
    type: 'range',
    min: 0.1,
    max: 1,
    step: 0.05,
    value: String(u?.opacity ?? 0.5),
    name: 'opacity',
  });
  opacity.addEventListener('change', () => {
    const cur = ctx.plan.underlay;
    if (cur) ctx.commit({ ...ctx.plan, underlay: { ...cur, opacity: opacity.valueAsNumber } });
  });
  return section(
    'Underlay',
    'underlay',
    h(
      'p',
      { class: 'meta' },
      u
        ? `${u.width_px} × ${u.height_px} px · ${(u.width_px * u.scale).toFixed(2)} m wide`
        : 'A drawing to trace over (PNG, JPEG, WebP or SVG).',
    ),
    !u && ignored
      ? h(
          'p',
          { class: 'hint', role: 'status', 'data-hint': 'underlay-ignored' },
          'The saved underlay pointed outside Chartroom, so it was not loaded. Import the image again.',
        )
      : null,
    field(u ? 'Replace image' : 'Import image', input),
    u ? field('Opacity', opacity) : null,
    u
      ? h('p', { class: 'hint' }, 'Calibrate with Measure (two points) or a room’s real area.')
      : null,
    u
      ? button('Remove underlay', () => ctx.commit({ ...ctx.plan, underlay: null }), {
          class: 'danger',
          'data-action': 'remove-underlay',
        })
      : null,
  );
}
