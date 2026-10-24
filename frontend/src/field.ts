// The heatmap field, as pure maths shared by the worker, the WebGL2 renderer and the tests.
//
// Sensors are points with a value. Between them the field is linear (docs/render-design.md):
// - 3+ sensors spread out: a Delaunay triangulation (Bowyer-Watson, written here) and barycentric
//   interpolation inside each triangle; outside the convex hull, the value of the nearest point
//   on the nearest hull edge.
// - 2 sensors, or 3+ nearly on a line: segment mode. Project onto the line through them, lerp
//   between neighbours, clamp at the ends. That is the same "nearest edge" rule over a chain.
// - 1 sensor: flat. 0 sensors: nothing.
// Walls are boundaries: field-plan.ts picks, per cell, the sensors this runs over.
import { polygonArea, signedArea } from './geometry';
import type { Point } from './plan/types';

export type FieldMode = 'none' | 'flat' | 'segment' | 'mesh';

/** Sensors closer than this (metres) are one node with their mean value. */
export const MERGE_DISTANCE = 0.001;
/** Hull area below this times the squared spread counts as a line (segment mode). */
export const COLLINEAR_RATIO = 0.02;
/** Confidence falls from 1 to `CONF_MIN` between these distances (m) from the nearest sensor. */
export const CONF_NEAR = 3;
export const CONF_FAR = 8;
export const CONF_MIN = 0.3;
/** Outside the outline the layer shows at this strength, fading to nothing over `FADE_DISTANCE`. */
export const OUTSIDE_ALPHA = 0.45;
export const FADE_DISTANCE = 2.5;
/** Grid cells along the longer side of the plan. */
export const GRID_CELLS = 256;

/** The triangulated (or degenerate) sensor layout. Indices refer to `nodes`. */
export interface FieldMesh {
  mode: FieldMode;
  /** Node positions; in segment mode projected onto the line. */
  nodes: Point[];
  /** For each node, the indices of the input sensors it averages. */
  members: number[][];
  /** Triangles, three node indices each, counter-clockwise (mesh mode). */
  tris: number[];
  /**
   * Edges the outside rule projects onto, two node indices each: the hull (mesh), the chain
   * (segment) or one degenerate edge (flat).
   */
  edges: number[];
}

const orient = (a: Point, b: Point, c: Point): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Convex hull, counter-clockwise, without collinear points (Andrew's monotone chain). */
export function convexHull(points: readonly Point[]): number[] {
  const idx = points.map((_, i) => i);
  idx.sort((a, b) => points[a]![0] - points[b]![0] || points[a]![1] - points[b]![1]);
  if (idx.length < 3) return idx;
  const build = (order: number[]): number[] => {
    const out: number[] = [];
    for (const i of order) {
      while (
        out.length >= 2 &&
        orient(points[out[out.length - 2]!]!, points[out[out.length - 1]!]!, points[i]!) <= 0
      )
        out.pop();
      out.push(i);
    }
    out.pop();
    return out;
  };
  return [...build(idx), ...build([...idx].reverse())];
}

/**
 * Delaunay triangulation by Bowyer-Watson. Returns counter-clockwise triangles as index triples,
 * or null when the result does not tile the convex hull (the caller falls back to segment mode).
 */
export function delaunay(points: readonly Point[]): number[] | null {
  const n = points.length;
  if (n < 3) return null;
  // Work in normalised coordinates around the centroid so epsilons mean the same at any size.
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0] / n;
    cy += p[1] / n;
  }
  let r = 0;
  for (const p of points) r = Math.max(r, Math.abs(p[0] - cx), Math.abs(p[1] - cy));
  if (r === 0) return null;
  const pts: Point[] = points.map((p) => [(p[0] - cx) / r, (p[1] - cy) / r]);
  const hull = convexHull(pts);
  const hullArea = signedArea(hull.map((i) => pts[i]!));
  for (const big of [50, 500, 5000]) {
    const tris = bowyerWatson(pts, big);
    let area = 0;
    let ok = true;
    for (let t = 0; t < tris.length; t += 3) {
      const a = orient(pts[tris[t]!]!, pts[tris[t + 1]!]!, pts[tris[t + 2]!]!) / 2;
      if (a <= 1e-12) ok = false;
      area += a;
    }
    if (ok && Math.abs(area - hullArea) <= 1e-9 * Math.max(1, hullArea)) return tris;
  }
  return null;
}

function bowyerWatson(pts: readonly Point[], big: number): number[] {
  const n = pts.length;
  // A super-triangle around the unit square, far enough out that its corners do not take part.
  const all: Point[] = [...pts, [-big, -big], [big, -big], [0, big]];
  type Tri = { a: number; b: number; c: number; ux: number; uy: number; r2: number };
  const make = (a: number, b: number, c: number): Tri => {
    const [ax, ay] = all[a]!;
    const [bx, by] = all[b]!;
    const [qx, qy] = all[c]!;
    const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = qx * qx + qy * qy;
    const ux = (a2 * (by - qy) + b2 * (qy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (qx - bx) + b2 * (ax - qx) + c2 * (bx - ax)) / d;
    return { a, b, c, ux, uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris: Tri[] = [make(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = all[i]!;
    const bad: Tri[] = [];
    const keep: Tri[] = [];
    for (const t of tris) {
      const d2 = (px - t.ux) ** 2 + (py - t.uy) ** 2;
      // Strictly inside the circumcircle (with a relative tolerance) is "bad".
      if (d2 < t.r2 * (1 - 1e-12)) bad.push(t);
      else keep.push(t);
    }
    // The cavity boundary: edges of bad triangles whose reverse is not also a bad edge.
    const edges = new Map<string, [number, number]>();
    for (const t of bad) {
      for (const [u, v] of [
        [t.a, t.b],
        [t.b, t.c],
        [t.c, t.a],
      ] as const) {
        const rev = `${v},${u}`;
        if (edges.has(rev)) edges.delete(rev);
        else edges.set(`${u},${v}`, [u, v]);
      }
    }
    for (const [u, v] of edges.values()) {
      if (orient(all[u]!, all[v]!, all[i]!) > 0) keep.push(make(u, v, i));
    }
    tris = keep;
  }
  const out: number[] = [];
  for (const t of tris) if (t.a < n && t.b < n && t.c < n) out.push(t.a, t.b, t.c);
  return out;
}

/** Boundary edges of a triangle set (each counter-clockwise edge without a twin). */
export function hullEdges(tris: readonly number[]): number[] {
  const seen = new Set<string>();
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) seen.add(`${tris[t + k]},${tris[t + ((k + 1) % 3)]}`);
  const out: number[] = [];
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const u = tris[t + k]!;
      const v = tris[t + ((k + 1) % 3)]!;
      if (!seen.has(`${v},${u}`)) out.push(u, v);
    }
  return out;
}

/** Merge sensors at the same spot, then choose the mode and build triangles and edges. */
export function buildMesh(sensors: readonly Point[]): FieldMesh {
  const nodes: Point[] = [];
  const members: number[][] = [];
  sensors.forEach((p, i) => {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    const j = nodes.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < MERGE_DISTANCE);
    if (j >= 0) members[j]!.push(i);
    else {
      nodes.push([p[0], p[1]]);
      members.push([i]);
    }
  });
  if (nodes.length === 0) return { mode: 'none', nodes, members, tris: [], edges: [] };
  if (nodes.length === 1) return { mode: 'flat', nodes, members, tris: [], edges: [0, 0] };
  if (nodes.length >= 3) {
    let spread = 0;
    for (const a of nodes)
      for (const b of nodes) spread = Math.max(spread, Math.hypot(a[0] - b[0], a[1] - b[1]));
    const area = polygonArea(convexHull(nodes).map((i) => nodes[i]!));
    if (area >= COLLINEAR_RATIO * spread * spread) {
      const tris = delaunay(nodes);
      if (tris && tris.length > 0)
        return { mode: 'mesh', nodes, members, tris, edges: hullEdges(tris) };
    }
  }
  return segmentMesh(nodes, members);
}

/** Project nodes onto their principal line and chain them in order along it. */
function segmentMesh(nodes: Point[], members: number[][]): FieldMesh {
  const n = nodes.length;
  let cx = 0;
  let cy = 0;
  for (const p of nodes) {
    cx += p[0] / n;
    cy += p[1] / n;
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of nodes) {
    sxx += (x - cx) ** 2;
    sxy += (x - cx) * (y - cy);
    syy += (y - cy) ** 2;
  }
  // Principal axis of the 2x2 covariance.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ts = nodes.map(([x, y]) => (x - cx) * dx + (y - cy) * dy);
  const order = nodes.map((_, i) => i).sort((a, b) => ts[a]! - ts[b]!);
  const out: Point[] = [];
  const outMembers: number[][] = [];
  let lastT = -Infinity;
  for (const i of order) {
    const t = ts[i]!;
    if (t - lastT < MERGE_DISTANCE) outMembers[outMembers.length - 1]!.push(...members[i]!);
    else {
      out.push([cx + t * dx, cy + t * dy]);
      outMembers.push([...members[i]!]);
      lastT = t;
    }
  }
  if (out.length === 1)
    return { mode: 'flat', nodes: out, members: outMembers, tris: [], edges: [0, 0] };
  const edges: number[] = [];
  for (let i = 0; i + 1 < out.length; i++) edges.push(i, i + 1);
  return { mode: 'segment', nodes: out, members: outMembers, tris: [], edges };
}

/** Node values: the mean of each node's member sensors. */
export function nodeValues(mesh: FieldMesh, values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(mesh.nodes.length);
  mesh.members.forEach((m, i) => {
    let s = 0;
    for (const k of m) s += values[k]!;
    out[i] = s / m.length;
  });
  return out;
}

/** Weights of up to three nodes whose mix gives the field at a point. */
export interface Weights {
  idx: [number, number, number];
  w: [number, number, number];
}

/** Clamped projection onto the nearest edge: the outside-the-hull rule. */
export function nearestEdge(
  mesh: FieldMesh,
  x: number,
  y: number,
): { a: number; b: number; t: number; d2: number } {
  let best = { a: 0, b: 0, t: 0, d2: Infinity };
  const { nodes, edges } = mesh;
  for (let e = 0; e < edges.length; e += 2) {
    const [ax, ay] = nodes[edges[e]!]!;
    const [bx, by] = nodes[edges[e + 1]!]!;
    const ex = bx - ax;
    const ey = by - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
    const d2 = (x - ax - t * ex) ** 2 + (y - ay - t * ey) ** 2;
    if (d2 < best.d2) best = { a: edges[e]!, b: edges[e + 1]!, t, d2 };
  }
  return best;
}

/** Barycentric weights in the first triangle containing the point, or null outside the hull. */
export function locate(mesh: FieldMesh, x: number, y: number): Weights | null {
  const { nodes, tris } = mesh;
  const p: Point = [x, y];
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t]!;
    const ib = tris[t + 1]!;
    const ic = tris[t + 2]!;
    const a = nodes[ia]!;
    const b = nodes[ib]!;
    const c = nodes[ic]!;
    const area = orient(a, b, c);
    const wa = orient(b, c, p) / area;
    const wb = orient(c, a, p) / area;
    const wc = 1 - wa - wb;
    const eps = -1e-9;
    if (wa >= eps && wb >= eps && wc >= eps) return { idx: [ia, ib, ic], w: [wa, wb, wc] };
  }
  return null;
}

/** Weights for the field at a point, for any mode. */
export function weightsAt(mesh: FieldMesh, x: number, y: number): Weights | null {
  if (mesh.mode === 'none') return null;
  if (mesh.mode === 'flat') return { idx: [0, 0, 0], w: [1, 0, 0] };
  if (mesh.mode === 'mesh') {
    const inside = locate(mesh, x, y);
    if (inside) return inside;
  }
  const e = nearestEdge(mesh, x, y);
  return { idx: [e.a, e.b, e.b], w: [1 - e.t, e.t, 0] };
}

/** The interpolated value at a point (NaN without sensors). Reference for both renderers. */
export function evalField(
  mesh: FieldMesh,
  values: ArrayLike<number>,
  x: number,
  y: number,
): number {
  const w = weightsAt(mesh, x, y);
  if (!w) return NaN;
  const v = nodeValues(mesh, values);
  return w.w[0] * v[w.idx[0]]! + w.w[1] * v[w.idx[1]]! + w.w[2] * v[w.idx[2]]!;
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 1 near a sensor, falling to `CONF_MIN` far from every sensor: where the map is a guess. */
export function confidenceAt(mesh: FieldMesh, x: number, y: number): number {
  let d2 = Infinity;
  for (const [nx, ny] of mesh.nodes) d2 = Math.min(d2, (x - nx) ** 2 + (y - ny) ** 2);
  if (d2 === Infinity) return 0;
  return 1 - (1 - CONF_MIN) * smoothstep(CONF_NEAR, CONF_FAR, Math.sqrt(d2));
}

/** Point in polygon (even-odd) and distance to its boundary. */
export function outlineDistance(
  outline: readonly Point[],
  x: number,
  y: number,
): { inside: boolean; d: number } {
  let inside = false;
  let d2 = Infinity;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, ay] = outline[j]!;
    const [bx, by] = outline[i]!;
    if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
    const ex = bx - ax;
    const ey = by - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
    d2 = Math.min(d2, (x - ax - t * ex) ** 2 + (y - ay - t * ey) ** 2);
  }
  return { inside, d: Math.sqrt(d2) };
}

/** Full strength inside the house, a faint fade outside it. 1 everywhere without an outline. */
export function fadeAt(outline: readonly Point[], x: number, y: number): number {
  if (outline.length < 3) return 1;
  const { inside, d } = outlineDistance(outline, x, y);
  return inside ? 1 : OUTSIDE_ALPHA * (1 - smoothstep(0, FADE_DISTANCE, d));
}

/** The grid both renderers fill: cell (i, j) has its centre at (x0 + (i+½)·cell, y0 + (j+½)·cell). */
export interface FieldGrid {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
}

export function fieldGrid(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  margin = FADE_DISTANCE,
  cells = GRID_CELLS,
): FieldGrid {
  const w = Math.max(0.1, bounds.maxX - bounds.minX + 2 * margin);
  const h = Math.max(0.1, bounds.maxY - bounds.minY + 2 * margin);
  const cell = Math.max(w, h) / cells;
  const nx = Math.max(1, Math.ceil(w / cell));
  const ny = Math.max(1, Math.ceil(h / cell));
  return {
    x0: (bounds.minX + bounds.maxX) / 2 - (nx * cell) / 2,
    y0: (bounds.minY + bounds.maxY) / 2 - (ny * cell) / 2,
    cell,
    nx,
    ny,
  };
}
