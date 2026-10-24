// Per-cell weights for the temperature and humidity field, worked out once per layout (sensors,
// walls, door states) by the worker. Walls are boundaries, doorways are not (docs/render-design.md,
// "Walls are boundaries"):
// - a cell is weighted by its path distance to each sensor: the straight line where nothing is in
//   the way, otherwise the shortest way round that crosses no barrier (walls, closed doors,
//   windows; signal.ts barrierSegments), so values flow through open doorways and gaps;
// - inverse path distance over the three nearest sensors: linear between two sensors in an open
//   room (25 halfway between 20 and 30), continuous across an open doorway and fading into the
//   room beyond it, a sharp step at a wall or a closed door;
// - confidence drops with distance and with the detour a value took round a corner;
// - cells nothing reaches, and everything outside the outline, are "no data" (drawn grey).
// The result is fixed weights per cell over the sensor nodes, so values still animate on the GPU
// (heat/gl-renderer.ts) or in fillField without redoing any of this.
import {
  buildMesh,
  CONF_FAR,
  CONF_MIN,
  CONF_NEAR,
  fadeAt,
  outlineDistance,
  smoothstep,
  type FieldGrid,
  type FieldMesh,
} from './field';
import type { Point } from './plan/types';

/** Confidence marking a cell with no data (drawn grey, not coloured). */
export const NO_DATA = -1;
/** Confidence of values that only reach a cell round a corner or through an opening. */
export const THROUGH_OPENING = 0.6;

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

/** Sensors kept per cell: the three nearest, and a fourth whose weight the others give up. */
const KEEP = 4;
/** Detour (m) round a corner or through a doorway over which confidence drops to THROUGH_OPENING. */
export const DETOUR_FADE = 1;
/** Detour (m) that cuts a sensor's weight to 1/e: how far a value carries round a corner. */
export const DETOUR_FALLOFF = 1;
/** Distance (m) into another room than its own that cuts a sensor's weight to 1/e. */
export const ROOM_FALLOFF = 1.5;
/** Grid steps the path search takes (dx, dy), each only between cells no barrier passes through. */
const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
  [1, 2],
  [1, -2],
  [-1, 2],
  [-1, -2],
];

/**
 * The wall-aware field plan. `walls` are barrier segments (four floats each). Returns the sensor
 * nodes (sensors at one spot merged) and the per-cell plan. `rooms` (the plan's room polygons)
 * only say how far a value has come into a room other than its sensor's, to fade it there.
 *
 * Each cell is weighted by its path distance to the sensors: the straight line when nothing is in
 * the way, otherwise the shortest way round through openings (a search over the grid, seeded with
 * the exact straight-line distance wherever a sensor is in sight). Weights are inverse distance
 * over the three nearest sensors, less the fourth's, so they change smoothly as one drops out.
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
  const { nx, ny, cell } = grid;
  const cells = nx * ny;
  const idx = new Int32Array(cells * 3);
  const w = new Float32Array(cells * 3);
  const conf = new Float32Array(cells).fill(NO_DATA);
  const fade = new Float32Array(cells);
  const plan = { grid, nodes: N, idx, w, conf, fade };
  const inside = new Uint8Array(cells);
  const cx = (c: number): number => grid.x0 + ((c % nx) + 0.5) * cell;
  const cy = (c: number): number => grid.y0 + (Math.floor(c / nx) + 0.5) * cell;
  for (let c = 0; c < cells; c++) {
    fade[c] = fadeAt(outline, cx(c), cy(c));
    inside[c] = fade[c]! >= 1 ? 1 : 0;
  }
  if (!N) return { mesh, plan };
  // Only cells inside the outline can take a value: work visibility out over its bounding box.
  let [l, t, r, b] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of outline)
    [l, t, r, b] = [Math.min(l, x), Math.min(t, y), Math.max(r, x), Math.max(b, y)];
  const at = (v: number, o: number, n: number) =>
    Math.min(n - 1, Math.max(0, Math.floor((v - o) / cell)));
  const vis = visibility(
    nodes,
    grid,
    walls,
    outline.length
      ? [at(l, grid.x0, nx), at(t, grid.y0, ny), at(r, grid.x0, nx), at(b, grid.y0, ny)]
      : undefined,
  );
  const wall = barrierCells(grid, walls);
  // Room of each cell and node (-1 outside every room); a node counts for the first room holding it.
  const cellRoom = new Int16Array(cells).fill(-1);
  rooms.forEach((poly, r) =>
    scanPolygon(grid, poly, (j, i0, i1) => {
      for (let i = i0; i <= i1; i++) if (cellRoom[j * nx + i] === -1) cellRoom[j * nx + i] = r;
    }),
  );
  const nodeRoom = nodes.map(([x, y]) => rooms.findIndex((p) => inPolygon(p, x, y)));
  // Up to KEEP (sensor, distance) labels per cell, settled nearest first (Dijkstra).
  const labN = new Int32Array(cells * KEEP).fill(-1);
  const labD = new Float32Array(cells * KEEP);
  // Path length at which each label's path left its sensor's room (Infinity: it has not).
  const labX = new Float32Array(cells * KEEP);
  const done = new Uint8Array(cells * KEEP);
  let hk = new Float64Array(1024);
  let hv = new Int32Array(2048);
  let size = 0;
  const push = (d: number, c: number, n: number): void => {
    if (size === hk.length) {
      const k2 = new Float64Array(size * 2);
      k2.set(hk);
      hk = k2;
      const v2 = new Int32Array(size * 4);
      v2.set(hv);
      hv = v2;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p]! <= d) break;
      hk[i] = hk[p]!;
      hv[2 * i] = hv[2 * p]!;
      hv[2 * i + 1] = hv[2 * p + 1]!;
      i = p;
    }
    hk[i] = d;
    hv[2 * i] = c;
    hv[2 * i + 1] = n;
  };
  const pop = (): void => {
    const d = hk[--size]!;
    const c = hv[2 * size]!;
    const n = hv[2 * size + 1]!;
    let i = 0;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= size) break;
      if (m + 1 < size && hk[m + 1]! < hk[m]!) m++;
      if (hk[m]! >= d) break;
      hk[i] = hk[m]!;
      hv[2 * i] = hv[2 * m]!;
      hv[2 * i + 1] = hv[2 * m + 1]!;
      i = m;
    }
    hk[i] = d;
    hv[2 * i] = c;
    hv[2 * i + 1] = n;
  };
  const offer = (c: number, n: number, dist: number, exit: number): void => {
    const d = Math.fround(dist);
    const base = c * KEEP;
    let free = -1;
    let worst = -1;
    for (let k = 0; k < KEEP; k++) {
      const s = base + k;
      const m = labN[s]!;
      if (m === n) {
        if (done[s] || labD[s]! <= d) return;
        labD[s] = d;
        labX[s] = exit;
        push(d, c, n);
        return;
      }
      if (m < 0) {
        if (free < 0) free = s;
      } else if (!done[s] && (worst < 0 || labD[s]! > labD[worst]!)) worst = s;
    }
    const s = free >= 0 ? free : worst >= 0 && labD[worst]! > d ? worst : -1;
    if (s < 0) return;
    labN[s] = n;
    labD[s] = d;
    labX[s] = exit;
    push(d, c, n);
  };
  const straight = (c: number, n: number): number =>
    Math.hypot(cx(c) - nodes[n]![0], cy(c) - nodes[n]![1]);
  nodes.forEach(([x, y], n) => {
    const i = Math.floor((x - grid.x0) / cell);
    const j = Math.floor((y - grid.y0) / cell);
    const c0 = j * nx + i;
    if (i >= 0 && j >= 0 && i < nx && j < ny && inside[c0]) {
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const c = (j + dj) * nx + i + di;
          if (i + di < 0 || i + di >= nx || j + dj < 0 || j + dj >= ny) continue;
          if (inside[c] && vis[n * cells + c]) offer(c, n, straight(c, n), Infinity);
        }
    } else
      for (let c = 0; c < cells; c++)
        if (inside[c] && vis[n * cells + c]) offer(c, n, straight(c, n), Infinity);
  });
  const open = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < nx && j < ny && !wall[j * nx + i] && inside[j * nx + i] === 1;
  while (size) {
    const d = hk[0]!;
    const c = hv[0]!;
    const n = hv[1]!;
    pop();
    let s = c * KEEP;
    while (s < c * KEEP + KEEP && !(labN[s] === n && !done[s] && labD[s] === d)) s++;
    if (s === c * KEEP + KEEP) continue;
    done[s] = 1;
    // A barrier cell takes a value but passes none on, so nothing leaks across a wall.
    if (wall[c]) continue;
    const i = c % nx;
    const j = (c - i) / nx;
    for (const [di, dj] of STEPS) {
      const i2 = i + di;
      const j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny || !inside[j2 * nx + i2]) continue;
      // Diagonal and knight steps also need the cells they cut through to be clear.
      if (di && dj) {
        const si = Math.sign(di);
        const sj = Math.sign(dj);
        if (Math.abs(di) === 2 ? !open(i + si, j) || !open(i + si, j + sj) : false) continue;
        if (Math.abs(dj) === 2 ? !open(i, j + sj) || !open(i + si, j + sj) : false) continue;
        if (Math.abs(di) === 1 && Math.abs(dj) === 1 && (!open(i + si, j) || !open(i, j + sj)))
          continue;
      }
      const c2 = j2 * nx + i2;
      const step = Math.hypot(di, dj) * cell;
      const d2 = vis[n * cells + c2] ? straight(c2, n) : d + step;
      // Leaving the sensor's room: note where, less the bit of this step past the room's edge.
      const r = nodeRoom[n]!;
      let exit = labX[s]!;
      if (exit === Infinity && r >= 0 && cellRoom[c2] !== r) {
        const o = outlineDistance(rooms[r]!, cx(c2), cy(c2));
        if (!o.inside) exit = d2 - o.d;
      }
      offer(c2, n, d2, exit);
    }
  }
  const floor = cell / 2;
  const lab: { n: number; d: number; e: number; wt: number }[] = [];
  for (let c = 0; c < cells; c++) {
    lab.length = 0;
    let nearest = Infinity;
    for (let s = c * KEEP; s < c * KEEP + KEEP; s++) {
      const n = labN[s]!;
      if (n < 0) continue;
      const d = labD[s]!;
      const e = Math.max(0, d - straight(c, n));
      // How far the path has come since it left the sensor's room (through a doorway).
      const h = Math.max(0, d - labX[s]!);
      nearest = Math.min(nearest, d);
      // A value counts for less the further it went out of its way round a corner or through a
      // doorway, and the further it has come into another room: a wall stays a sharp edge and
      // the room beyond a doorway fades back to its own sensors.
      lab.push({
        n,
        d,
        e,
        wt: Math.exp(-e / DETOUR_FALLOFF - h / ROOM_FALLOFF) / Math.max(floor, d),
      });
    }
    if (!lab.length) continue;
    lab.sort((p, q) => q.wt - p.wt);
    const use = Math.min(3, lab.length);
    const last = lab.length > 3 ? lab[3]!.wt : 0;
    let sum = 0;
    for (let m = 0; m < use; m++) sum += lab[m]!.wt - last;
    let through = 0;
    for (let m = 0; m < use; m++) {
      const { n, e, wt } = lab[m]!;
      const v = sum > 0 ? (wt - last) / sum : 1 / use;
      idx[c * 3 + m] = n;
      w[c * 3 + m] = v;
      // How much of the value came round a corner or through a doorway.
      through += v * smoothstep(0, DETOUR_FADE, e);
    }
    const near = 1 - (1 - CONF_MIN) * smoothstep(CONF_NEAR, CONF_FAR, nearest);
    conf[c] = near * (1 - (1 - THROUGH_OPENING) * through);
  }
  return { mesh, plan };
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
