// 2D geometry for plans, in metres (x right, y down). Pure functions, shared by the SVG renderer,
// the editor and the tests. Only type imports, so Node can load it with type stripping.
import type { Door, Opening, Plan, Wall } from './plan/models';
import type { Point } from './plan/types';

export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
export const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: Point): number => Math.hypot(a[0], a[1]);
export const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const same = (a: Point, b: Point, eps = 1e-6): boolean => dist(a, b) <= eps;

/** Round to millimetres, so stored plans stay small and comparisons stay exact. */
export const roundToMm = (v: number): number => Math.round(v * 1000) / 1000;
export const roundPointToMm = (p: Point): Point => [roundToMm(p[0]), roundToMm(p[1])];

/** Unit direction of a wall and its left normal (the side where `(b - a) x (p - a) > 0`). */
export function frame(wall: Wall): { u: Point; n: Point; length: number } {
  const d = sub(wall.b, wall.a);
  const length = len(d);
  const u: Point = length > 0 ? mul(d, 1 / length) : [1, 0];
  return { u, n: [-u[1], u[0]], length };
}

/** Parameter of the projection of `p` onto the wall's centreline, in metres from `a`, unclamped. */
export function along(wall: Wall, p: Point): number {
  const { u } = frame(wall);
  return dot(sub(p, wall.a), u);
}

/** Closest point on segment a-b to p, and its distance. */
export function closestOnSegment(
  a: Point,
  b: Point,
  p: Point,
): { point: Point; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const point = add(a, mul(ab, t));
  return { point, t, d: dist(point, p) };
}

/** Signed area of a polygon (shoelace); positive when clockwise in y-down plan space. */
export function signedArea(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++)
    sum += cross(polygon[i]!, polygon[(i + 1) % polygon.length]!);
  return sum / 2;
}

/** Area of a simple polygon, either winding. */
export const polygonArea = (polygon: readonly Point[]): number => Math.abs(signedArea(polygon));

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(polygon: readonly Point[]): Point {
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % polygon.length]!;
    const c = cross(p, q);
    a2 += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

export function pointInPolygon([x, y]: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The wall's solid pieces between openings, as [from, to] distances from `a`. */
export function solidSpans(wall: Wall, openings: readonly Opening[]): [number, number][] {
  const total = frame(wall).length;
  const gaps = openings
    .filter((o) => o.wall === wall.id)
    .map((o) => [o.offset, o.offset + o.width] as [number, number])
    .sort((p, q) => p[0] - q[0]);
  const spans: [number, number][] = [];
  let at = 0;
  for (const [g0, g1] of gaps) {
    if (g0 > at) spans.push([at, g0]);
    at = Math.max(at, g1);
  }
  if (at < total) spans.push([at, total]);
  return spans;
}

/** Rectangle of a piece of wall; ends can be extended by half the thickness so corners close. */
export function wallRect(
  wall: Wall,
  from: number,
  to: number,
  extendStart = false,
  extendEnd = false,
): Point[] {
  const { u, n } = frame(wall);
  const h = wall.thickness / 2;
  const p0 = add(wall.a, mul(u, from - (extendStart ? h : 0)));
  const p1 = add(wall.a, mul(u, to + (extendEnd ? h : 0)));
  return [add(p0, mul(n, h)), add(p1, mul(n, h)), add(p1, mul(n, -h)), add(p0, mul(n, -h))];
}

/** Solid wall polygons with openings cut out. */
export function wallPieces(wall: Wall, openings: readonly Opening[]): Point[][] {
  const total = frame(wall).length;
  return solidSpans(wall, openings).map(([s0, s1]) =>
    wallRect(wall, s0, s1, s0 === 0, s1 === total),
  );
}

/** Door drawn open at 90° into its swing side: hinge, leaf end and the closed free edge. */
export function doorGeometry(
  wall: Wall,
  door: Door,
): { hinge: Point; open: Point; closed: Point; sweep: 0 | 1 } {
  const { u, n: left } = frame(wall);
  const n = mul(left, door.swing);
  const start = add(wall.a, mul(u, door.offset));
  const end = add(wall.a, mul(u, door.offset + door.width));
  const face = wall.thickness / 2;
  const hinge = add(door.hinge === 'a' ? start : end, mul(n, face));
  const closed = add(door.hinge === 'a' ? end : start, mul(n, face));
  const open = add(hinge, mul(n, door.width));
  return { hinge, open, closed, sweep: cross(sub(closed, hinge), sub(open, hinge)) > 0 ? 1 : 0 };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Iterable<Point>): Bounds | null {
  let b: Bounds | null = null;
  for (const [x, y] of points) {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x);
      b.maxY = Math.max(b.maxY, y);
    }
  }
  return b;
}

/** Everything drawn: walls (with thickness), rooms, outline, sources and the underlay. */
export function planBounds(plan: Plan): Bounds | null {
  const pts: Point[] = [...plan.outline];
  for (const w of plan.walls) pts.push(...wallRect(w, 0, frame(w).length, true, true));
  for (const r of plan.rooms) pts.push(...r.polygon);
  for (const s of plan.sources) pts.push(s.position);
  const u = plan.underlay;
  if (u) {
    pts.push(u.origin, add(u.origin, [u.width_px * u.scale, u.height_px * u.scale]));
  }
  return boundsOf(pts);
}

function lineIntersection(p: Point, d: Point, q: Point, e: Point): Point | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(q, p), e) / den;
  return add(p, mul(d, t));
}

/**
 * The exterior polygon from the exterior walls: when they form one closed loop, each wall's centre
 * line is pushed outward by half its own thickness and neighbours are intersected. Otherwise the
 * bounding box of all walls. Empty when there are no walls.
 */
export function outlineFromWalls(plan: Plan, exterior = 'exterior'): Point[] {
  const loop = exteriorLoop(plan.walls.filter((w) => w.material === exterior));
  if (loop) {
    const corners = loop.map((step) => step.from);
    const sign = signedArea(corners) >= 0 ? 1 : -1;
    // Outward offset line for each edge: for a clockwise loop (positive area, y down) the outside
    // is to the right of the direction of travel.
    const lines = loop.map((step) => {
      const d = sub(step.to, step.from);
      const u = mul(d, 1 / len(d));
      const out: Point = mul([u[1], -u[0]], sign);
      return { p: add(step.from, mul(out, step.wall.thickness / 2)), d: u };
    });
    const pts: Point[] = [];
    for (let i = 0; i < lines.length; i++) {
      const prev = lines[(i + lines.length - 1) % lines.length]!;
      const cur = lines[i]!;
      // Collinear neighbours (a straight run split in two): keep the shared corner's offset.
      pts.push(roundPointToMm(lineIntersection(prev.p, prev.d, cur.p, cur.d) ?? cur.p));
    }
    return pts;
  }
  if (plan.walls.length === 0) return [];
  const b = boundsOf(plan.walls.flatMap((w) => wallRect(w, 0, frame(w).length, true, true)))!;
  return [
    roundPointToMm([b.minX, b.minY]),
    roundPointToMm([b.maxX, b.minY]),
    roundPointToMm([b.maxX, b.maxY]),
    roundPointToMm([b.minX, b.maxY]),
  ];
}

interface Step {
  wall: Wall;
  from: Point;
  to: Point;
}

/** Walls chained end to end into one closed loop, each endpoint shared by exactly two walls. */
export function exteriorLoop(walls: readonly Wall[]): Step[] | null {
  if (walls.length < 3) return null;
  const key = (p: Point): string => `${roundToMm(p[0])},${roundToMm(p[1])}`;
  const at = new Map<string, Wall[]>();
  for (const w of walls) {
    for (const p of [w.a, w.b]) at.set(key(p), [...(at.get(key(p)) ?? []), w]);
  }
  if ([...at.values()].some((list) => list.length !== 2)) return null;
  const steps: Step[] = [];
  let wall = walls[0]!;
  let from = wall.a;
  const used = new Set<string>();
  while (!used.has(wall.id)) {
    used.add(wall.id);
    const to = same(wall.a, from, 5e-4) ? wall.b : wall.a;
    steps.push({ wall, from, to });
    const next = at.get(key(to))!.find((w) => w.id !== wall.id)!;
    wall = next;
    from = to;
  }
  return used.size === walls.length && same(from, walls[0]!.a, 5e-4) ? steps : null;
}
