// Per-cell weights for the temperature and humidity field, worked out once per layout (sensors,
// walls, door states) by the worker. Walls are boundaries (docs/render-design.md, "Walls are
// boundaries"):
// - a cell takes its value only from the sensors it can see: a straight line from the cell centre
//   to the sensor that crosses no barrier (walls, closed doors, windows; signal.ts barrierSegments);
// - in a room with a sensor of its own the cell uses just that room's sensors (one sensor: flat);
// - among the visible sensors the field is linear as before (field.ts: mesh, segment, flat);
// - cells that see no sensor take the value of the nearest valued cell reachable without crossing
//   a barrier (through doorways), with lower confidence the further it travelled;
// - whatever is still empty, and everything outside the outline, is "no data" (drawn grey).
// The result is fixed weights per cell over the sensor nodes, so values still animate on the GPU
// (heat-gl.ts) or in fillField without redoing any of this.
import {
  buildMesh,
  CONF_FAR,
  CONF_MIN,
  CONF_NEAR,
  fadeAt,
  smoothstep,
  weightsAt,
  type FieldGrid,
  type FieldMesh,
} from './field';
import type { Point } from './plan';

/** Confidence marking a cell with no data (drawn grey, not coloured). */
export const NO_DATA = -1;
/** Confidence of values that only reach a cell through an opening, before distance fades it. */
export const THROUGH_OPENING = 0.6;
/** Distance (m) over which a value carried through an opening fades to half that. */
export const CARRY_FADE = 6;

/** Per-cell weights over the nodes, confidence (or NO_DATA) and fade: one per layout. */
export interface FieldPlan {
  grid: FieldGrid;
  nodes: number;
  idx: Int32Array;
  w: Float32Array;
  conf: Float32Array;
  fade: Float32Array;
}

/** Calls `fill(row, i0, i1)` for the cells whose centres a convex or simple polygon covers (even-odd). */
function scanPolygon(
  grid: FieldGrid,
  poly: readonly Point[],
  fill: (row: number, i0: number, i1: number) => void,
): void {
  const n = poly.length;
  if (n < 3) return;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const j0 = Math.max(0, Math.ceil((y0 - grid.y0) / grid.cell - 0.5));
  const j1 = Math.min(grid.ny - 1, Math.floor((y1 - grid.y0) / grid.cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = grid.y0 + (j + 0.5) * grid.cell;
    xs.length = 0;
    for (let k = 0, m = n - 1; k < n; m = k++) {
      const [ax, ay] = poly[m]!;
      const [bx, by] = poly[k]!;
      if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - grid.x0) / grid.cell - 0.5));
      const i1 = Math.min(grid.nx - 1, Math.floor((xs[k + 1]! - grid.x0) / grid.cell - 0.5));
      if (i1 >= i0) fill(j, i0, i1);
    }
  }
}

/**
 * Which cells each node sees: 1 unless the cell lies in the shadow some barrier casts from it.
 * Each shadow is the (convex) quad behind the segment, away from the node, filled row by row;
 * only rows and columns inside `clip` (cells, inclusive) are worked out.
 */
export function visibility(
  nodes: readonly Point[],
  grid: FieldGrid,
  walls: ArrayLike<number>,
  clip = [0, 0, grid.nx - 1, grid.ny - 1],
): Uint8Array {
  const { nx, cell, x0, y0 } = grid;
  const cells = nx * grid.ny;
  const vis = new Uint8Array(nodes.length * cells).fill(1);
  const far = 4 * (nx + grid.ny) * cell;
  const q = new Float64Array(8);
  // Neighbouring shadows share an edge: widen each a hair so rounding leaves no gap between them.
  const grow = 1e-4;
  nodes.forEach(([sx, sy], n) => {
    const base = n * cells;
    for (let k = 0; k + 3 < walls.length; k += 4) {
      const ax = walls[k]!;
      const ay = walls[k + 1]!;
      const bx = walls[k + 2]!;
      const by = walls[k + 3]!;
      if (Math.abs((ax - sx) * (by - sy) - (ay - sy) * (bx - sx)) < 1e-9) continue;
      const da = far / Math.max(1e-6, Math.hypot(ax - sx, ay - sy));
      const db = far / Math.max(1e-6, Math.hypot(bx - sx, by - sy));
      q.set([ax, ay, bx, by, bx + (bx - sx) * db, by + (by - sy) * db]);
      q[6] = ax + (ax - sx) * da;
      q[7] = ay + (ay - sy) * da;
      const lo = Math.min(q[1]!, q[3]!, q[5]!, q[7]!);
      const hi = Math.max(q[1]!, q[3]!, q[5]!, q[7]!);
      const j0 = Math.max(clip[1]!, Math.ceil((lo - y0) / cell - 0.5));
      const j1 = Math.min(clip[3]!, Math.floor((hi - y0) / cell - 0.5));
      for (let j = j0; j <= j1; j++) {
        const y = y0 + (j + 0.5) * cell;
        let xa = Infinity;
        let xb = -Infinity;
        for (let e = 0; e < 8; e += 2) {
          const px = q[e]!;
          const py = q[e + 1]!;
          const qx = q[(e + 2) % 8]!;
          const qy = q[(e + 3) % 8]!;
          if (py > y !== qy > y) {
            const x = px + ((y - py) * (qx - px)) / (qy - py);
            xa = Math.min(xa, x);
            xb = Math.max(xb, x);
          }
        }
        const i0 = Math.max(clip[0]!, Math.ceil((xa - x0) / cell - 0.5 - grow));
        const i1 = Math.min(clip[2]!, Math.floor((xb - x0) / cell - 0.5 + grow));
        if (i1 >= i0) vis.fill(0, base + j * nx + i0, base + j * nx + i1 + 1);
      }
    }
  });
  return vis;
}

/** Cells a barrier passes through (every cell its line touches, so 4-neighbour steps cannot cross). */
export function barrierCells(grid: FieldGrid, walls: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(grid.nx * grid.ny);
  const cellOf = (x: number, y: number): [number, number] => [
    Math.floor((x - grid.x0) / grid.cell),
    Math.floor((y - grid.y0) / grid.cell),
  ];
  const mark = (i: number, j: number): void => {
    if (i >= 0 && j >= 0 && i < grid.nx && j < grid.ny) out[j * grid.nx + i] = 1;
  };
  for (let k = 0; k + 3 < walls.length; k += 4) {
    const ax = walls[k]!;
    const ay = walls[k + 1]!;
    const bx = walls[k + 2]!;
    const by = walls[k + 3]!;
    const steps = Math.max(1, Math.ceil((Math.hypot(bx - ax, by - ay) / grid.cell) * 4));
    let [pi, pj] = cellOf(ax, ay);
    mark(pi, pj);
    for (let s = 1; s <= steps; s++) {
      const [i, j] = cellOf(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
      if (i !== pi && j !== pj) mark(i, pj);
      mark(i, j);
      pi = i;
      pj = j;
    }
  }
  return out;
}

const inPolygon = (poly: readonly Point[], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]!;
    const [bx, by] = poly[i]!;
    if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
  }
  return inside;
};

/**
 * The wall-aware field plan. `walls` are barrier segments (four floats each), `rooms` the plan's
 * room polygons. Returns the sensor nodes (sensors at one spot merged) and the per-cell plan.
 */
export function planField(
  sensors: readonly Point[],
  grid: FieldGrid,
  outline: readonly Point[],
  walls: ArrayLike<number> = [],
  rooms: readonly (readonly Point[])[] = [],
): { mesh: FieldMesh; plan: FieldPlan } {
  const mesh = buildMesh(sensors);
  const nodes = mesh.nodes;
  const N = nodes.length;
  const cells = grid.nx * grid.ny;
  const idx = new Int32Array(cells * 3);
  const w = new Float32Array(cells * 3);
  const conf = new Float32Array(cells).fill(NO_DATA);
  const fade = new Float32Array(cells);
  const plan = { grid, nodes: N, idx, w, conf, fade };
  // Only cells inside the outline can take a value: work visibility out over its bounding box.
  let [l, t, r, b] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of outline)
    [l, t, r, b] = [Math.min(l, x), Math.min(t, y), Math.max(r, x), Math.max(b, y)];
  const at = (v: number, o: number, n: number) =>
    Math.min(n - 1, Math.max(0, Math.floor((v - o) / grid.cell)));
  const vis = visibility(
    nodes,
    grid,
    walls,
    outline.length
      ? [
          at(l, grid.x0, grid.nx),
          at(t, grid.y0, grid.ny),
          at(r, grid.x0, grid.nx),
          at(b, grid.y0, grid.ny),
        ]
      : undefined,
  );
  const wall = barrierCells(grid, walls);
  // Room of each cell and node (-1 outside every room); a node counts for the first room holding it.
  const cellRoom = new Int16Array(cells).fill(-1);
  rooms.forEach((poly, r) =>
    scanPolygon(grid, poly, (j, i0, i1) => {
      for (let i = i0; i <= i1; i++)
        if (cellRoom[j * grid.nx + i] === -1) cellRoom[j * grid.nx + i] = r;
    }),
  );
  const nodeRoom = nodes.map(([x, y]) => rooms.findIndex((p) => inPolygon(p, x, y)));
  const roomHasNode = new Set(nodeRoom);
  // One sub-mesh per distinct set of visible nodes, its nodes mapped back to ours.
  const subs = new Map<string, { sub: FieldMesh; map: number[][] }>();
  const subFor = (ids: number[]): { sub: FieldMesh; map: number[][] } => {
    const key = ids.join(',');
    let s = subs.get(key);
    if (!s) {
      const sub = buildMesh(ids.map((i) => nodes[i]!));
      s = { sub, map: sub.members.map((m) => m.map((k) => ids[k]!)) };
      subs.set(key, s);
    }
    return s;
  };
  const acc = new Map<number, number>();
  const inside = new Uint8Array(cells);
  const ids: number[] = [];
  for (let j = 0; j < grid.ny; j++) {
    const y = grid.y0 + (j + 0.5) * grid.cell;
    for (let i = 0; i < grid.nx; i++) {
      const x = grid.x0 + (i + 0.5) * grid.cell;
      const c = j * grid.nx + i;
      const f = fadeAt(outline, x, y);
      fade[c] = f;
      if (f < 1 || N === 0) continue;
      inside[c] = 1;
      ids.length = 0;
      const room = cellRoom[c]!;
      // Prefer the cell's own room's sensors when it sees any of them.
      for (const pass of room >= 0 && roomHasNode.has(room) ? [true, false] : [false]) {
        for (let n = 0; n < N; n++)
          if (vis[n * cells + c] && (!pass || nodeRoom[n] === room)) ids.push(n);
        if (ids.length) break;
      }
      if (!ids.length) continue;
      const { sub, map } = subFor(ids);
      const wt = weightsAt(sub, x, y)!;
      acc.clear();
      for (let k = 0; k < 3; k++) {
        const m = map[wt.idx[k]!]!;
        for (const g of m) acc.set(g, (acc.get(g) ?? 0) + wt.w[k]! / m.length);
      }
      // Up to three nodes, heaviest first (more only when merged nodes overlap: rare).
      const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const sum = top.reduce((s, e) => s + e[1], 0) || 1;
      top.forEach(([g, v], k) => {
        idx[c * 3 + k] = g;
        w[c * 3 + k] = v / sum;
      });
      let d2 = Infinity;
      for (const n of ids) d2 = Math.min(d2, (x - nodes[n]![0]) ** 2 + (y - nodes[n]![1]) ** 2);
      const near = 1 - (1 - CONF_MIN) * smoothstep(CONF_NEAR, CONF_FAR, Math.sqrt(d2));
      // A room without a sensor of its own only sees others through an opening.
      conf[c] = room >= 0 && !roomHasNode.has(room) ? near * THROUGH_OPENING : near;
    }
  }
  carry(plan, inside, wall);
  return { mesh, plan };
}

/**
 * Cells that see no sensor take the weights of the nearest valued cell reachable in 4-neighbour
 * steps that stay inside and do not pass through a barrier cell (a barrier cell takes a value but
 * passes none on, so nothing leaks across a wall). Confidence fades with the distance travelled.
 */
function carry(plan: FieldPlan, inside: Uint8Array, wall: Uint8Array): void {
  const { grid, idx, w, conf } = plan;
  const cells = grid.nx * grid.ny;
  const queue = new Int32Array(cells);
  const src = new Float32Array(cells);
  const dist = new Float32Array(cells);
  const done = new Uint8Array(cells);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < cells; c++)
    if (conf[c]! !== NO_DATA) {
      done[c] = 1;
      src[c] = conf[c]!;
      if (!wall[c]) queue[tail++] = c;
    }
  while (head < tail) {
    const c = queue[head++]!;
    const i = c % grid.nx;
    for (const n of [i > 0 ? c - 1 : -1, i < grid.nx - 1 ? c + 1 : -1, c - grid.nx, c + grid.nx]) {
      if (n < 0 || n >= cells || done[n] || !inside[n]) continue;
      done[n] = 1;
      idx.copyWithin(n * 3, c * 3, c * 3 + 3);
      w.copyWithin(n * 3, c * 3, c * 3 + 3);
      // Carried values count as seen through an opening, whatever the source cell had.
      src[n] = Math.min(src[c]!, THROUGH_OPENING);
      dist[n] = dist[c]! + grid.cell;
      conf[n] = src[n]! * (1 - 0.5 * smoothstep(0, CARRY_FADE, dist[n]!));
      if (!wall[n]) queue[tail++] = n;
    }
  }
}

/** Field samples for node values: value, confidence, fade per cell (row j = y0 + (j+½)·cell). */
export function fillField(
  fp: FieldPlan,
  nodeVals: ArrayLike<number>,
  out?: Float32Array,
): Float32Array {
  const cells = fp.grid.nx * fp.grid.ny;
  const f = out ?? new Float32Array(cells * 3);
  for (let c = 0; c < cells; c++) {
    const k = c * 3;
    f[k] =
      fp.nodes > 0
        ? fp.w[k]! * nodeVals[fp.idx[k]!]! +
          fp.w[k + 1]! * nodeVals[fp.idx[k + 1]!]! +
          fp.w[k + 2]! * nodeVals[fp.idx[k + 2]!]!
        : 0;
    f[k + 1] = fp.conf[c]!;
    f[k + 2] = fp.fade[c]!;
  }
  return f;
}
