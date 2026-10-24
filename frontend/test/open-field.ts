import type { Point } from '../src/plan';

/**
 * The open-plan field planField should give where nothing is in the way: inverse distance over
 * the three nearest sensors, less the fourth's weight (floor: half a cell).
 */
export function openField(
  nodes: readonly Point[],
  values: ArrayLike<number>,
  x: number,
  y: number,
  cell: number,
): number {
  const lab = nodes
    .map(([nx, ny], n) => ({ n, wt: 1 / Math.max(cell / 2, Math.hypot(x - nx, y - ny)) }))
    .sort((p, q) => q.wt - p.wt);
  const use = lab.slice(0, 3);
  const last = lab.length > 3 ? lab[3]!.wt : 0;
  const sum = use.reduce((s, l) => s + l.wt - last, 0);
  return use.reduce((s, l) => s + (values[l.n]! * (l.wt - last)) / sum, 0);
}
