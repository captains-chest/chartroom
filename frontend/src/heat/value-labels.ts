// The value labels next to the heatmap's sensors, and keeping them clear of the room names.
// Loaded with the heat layer (heat-layer.ts re-exports them for plan-view.ts).
import { LAYERS, type LayerData } from '../heat';
import { AREA_SIZE, declutter, NAME_SIZE } from '../labels';
import type { Point } from '../plan/types';
import { s } from '../ui';

/** Value labels next to the sensors of the active layer, at a constant size on screen. */
export function renderValueLabels(g: SVGGElement, data: LayerData | null): void {
  // Signal sources carry a level at 1 m, not a reading worth labelling.
  if (!data || data.layer === 'signal') {
    g.replaceChildren();
    return;
  }
  const spec = LAYERS[data.layer];
  const out: SVGElement[] = [];
  const at = (p: Point): { x: number; y: number } => ({ x: p[0], y: p[1] });
  for (const r of data.readings) {
    out.push(
      s(
        'text',
        { class: 'heat-value', ...at(r.position), 'data-id': r.id },
        `${r.value.toFixed(spec.digits)}${data.unit === '%' ? '%' : '°'}`,
      ),
    );
  }
  for (const x of data.excluded) {
    out.push(
      s(
        'text',
        { class: 'heat-value excluded', ...at(x.position), 'data-id': x.id },
        '–',
        s('title', {}, `${x.entity_id}: ${x.reason}, left out of the heatmap`),
      ),
    );
  }
  g.replaceChildren(...out);
}

/**
 * Keep value labels off the room names: move or hide them, and hide area labels they cover or
 * that are too small to read. Rerun after the labels change and on every zoom.
 */
export function declutterLabels(body: SVGGElement, values: SVGGElement, mpp: number): void {
  const num = (el: Element, a: string): number => Number(el.getAttribute(a)) || 0;
  const label = (el: Element, size: number) => ({
    x: num(el, 'x'),
    y: num(el, 'y'),
    size,
    chars: el.textContent?.length ?? 0,
  });
  const names = [...body.querySelectorAll('text.name')];
  const areas = [...body.querySelectorAll('text.area')];
  const rooms = names.map((n, i) => ({
    name: label(n, NAME_SIZE),
    area: label(areas[i] ?? n, AREA_SIZE),
  }));
  const texts = [...values.querySelectorAll('text.heat-value')];
  const r = declutter(
    texts.map((t) => ({ x: num(t, 'x'), y: num(t, 'y'), chars: t.textContent?.length ?? 0 })),
    rooms,
    mpp,
  );
  texts.forEach((t, i) => {
    t.classList.toggle('below', r.values[i] === 'below');
    t.classList.toggle('crowded', r.values[i] === 'hidden');
  });
  areas.forEach((a, i) => a.classList.toggle('crowded', !!r.areas[i]));
}
