// The editor's overlay: handles on the selection, the drawing in progress with its length, a
// measurement and the cursor, sized for the zoom (`mpp`: metres per screen pixel).
import { dist } from '../geometry';
import type { Plan } from '../plan/models';
import type { Point } from '../plan/types';
import { s } from '../ui';
import type { ToolState } from './models';

export function overlayNodes(state: ToolState, plan: Plan, mpp: number): SVGElement[] {
  const { tool, selection: sel, draft, measured, hover: cursor } = state;
  const k = mpp;
  const r = 5 * k;
  const out: SVGElement[] = [];
  const dot = (cls: string, [cx, cy]: Point, size = r, handle?: string): void => {
    out.push(s('circle', { class: cls, 'data-handle': handle, cx, cy, r: size }));
  };
  if (tool === 'select' && sel?.kind === 'wall') {
    const wall = plan.walls.find((w) => w.id === sel.id);
    if (wall)
      for (const end of ['a', 'b'] as const)
        dot('handle', wall[end], r * 1.4, `endpoint|${wall.id}|${end}`);
  }
  if (tool === 'select' && sel?.kind === 'room') {
    const room = plan.rooms.find((x) => x.id === sel.id);
    room?.polygon.forEach((pt, i) => dot('handle', pt, r, `vertex|${room.id}|${i}`));
  }
  const hover = cursor?.point;
  const chain = [...draft, ...(hover && draft.length > 0 ? [hover] : [])];
  if (chain.length > 1) {
    const pts = chain.map((q) => q.join(',')).join(' ');
    out.push(
      s(tool === 'room' ? 'polygon' : 'polyline', {
        class: `draft ${tool}`,
        points: pts,
      }),
    );
    const a = chain.at(-2)!;
    const b = chain.at(-1)!;
    out.push(
      s(
        'text',
        {
          class: 'measure-label',
          x: (a[0] + b[0]) / 2,
          y: (a[1] + b[1]) / 2 - 2 * r,
          'font-size': 12 * k,
        },
        `${dist(a, b).toFixed(2)} m`,
      ),
    );
  }
  for (const q of draft) dot('draft-point', q);
  if (measured) {
    const [a, b] = measured;
    out.push(s('line', { class: 'draft measure', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
    for (const q of measured) dot('draft-point', q);
  }
  if (hover && tool !== 'select') dot(cursor?.target ? 'cursor target' : 'cursor', hover, r * 0.8);
  return out;
}
