// Snapping the pointer while drawing and dragging: to wall ends and faces, else to the grid,
// straightened against the previous point.
import { add, dist, frame, roundPointToMm, roundToMm, same, wallRect } from '../geometry';
import type { Plan } from '../plan/models';
import type { Point } from '../plan/types';
import type { Snapped, SnapOptions } from './models';

/** Off-axis ratio under which a snapped point locks to the anchor's axis (tan 5° ≈ 0.09). */
const AXIS_LOCK_RATIO = 0.09;

/**
 * Points that snapping prefers: wall endpoints and, with `faces`, the corners where the faces of
 * joined walls meet (the inside corners of rooms), free wall-end corners and room corners.
 */
export function snapTargets(plan: Plan, faces: boolean): Point[] {
  const pts: Point[] = [];
  for (const w of plan.walls) pts.push(w.a, w.b);
  if (!faces) return pts;
  for (const w of plan.walls) pts.push(...wallRect(w, 0, frame(w).length, true, true));
  const ws = plan.walls;
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const p = ws[i]!;
      const q = ws[j]!;
      const joint = [p.a, p.b].find((e) => same(e, q.a) || same(e, q.b));
      if (!joint) continue;
      const fp = frame(p);
      const fq = frame(q);
      if (Math.abs(fp.u[0] * fq.u[1] - fp.u[1] * fq.u[0]) < 1e-9) continue;
      for (const sp of [1, -1]) {
        for (const sq of [1, -1]) {
          const a0 = add(p.a, [fp.n[0] * sp * (p.thickness / 2), fp.n[1] * sp * (p.thickness / 2)]);
          const b0 = add(q.a, [fq.n[0] * sq * (q.thickness / 2), fq.n[1] * sq * (q.thickness / 2)]);
          const den = fp.u[0] * fq.u[1] - fp.u[1] * fq.u[0];
          const t = ((b0[0] - a0[0]) * fq.u[1] - (b0[1] - a0[1]) * fq.u[0]) / den;
          pts.push(roundPointToMm([a0[0] + fp.u[0] * t, a0[1] + fp.u[1] * t]));
        }
      }
    }
  }
  for (const r of plan.rooms) pts.push(...r.polygon);
  return pts;
}

/** Snap to a nearby target, else to the grid, then straighten against the anchor. */
export function snap(p: Point, o: SnapOptions): Snapped {
  let best: Point | null = null;
  let bestD = o.radius;
  for (const t of o.targets) {
    if (o.exclude && same(t, o.exclude)) continue;
    const d = dist(t, p);
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  if (best) return { point: best, target: true };
  const g = o.grid > 0 ? o.grid : 0.001;
  let q: Point = [roundToMm(Math.round(p[0] / g) * g), roundToMm(Math.round(p[1] / g) * g)];
  if (o.anchor) {
    const dx = Math.abs(q[0] - o.anchor[0]);
    const dy = Math.abs(q[1] - o.anchor[1]);
    if (dy < dx * AXIS_LOCK_RATIO) q = [q[0], o.anchor[1]];
    else if (dx < dy * AXIS_LOCK_RATIO) q = [o.anchor[0], q[1]];
  }
  return { point: q, target: false };
}
