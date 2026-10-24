import { describe, expect, it } from 'vite-plus/test';
import { openField } from './open-field';
import {
  CONF_FAR,
  CONF_MIN,
  CONF_NEAR,
  OUTSIDE_ALPHA,
  buildMesh,
  convexHull,
  delaunay,
  fadeAt,
  fieldGrid,
  nodeValues,
  smoothstep,
} from '../src/field';
import { signedArea } from '../src/geometry';
import { NO_DATA, fillField, planField } from '../src/field-plan';
import type { Point } from '../src/plan/types';

/** A deterministic pseudo-random generator for the property tests. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const circumcircleEmpty = (pts: Point[], tris: number[]): boolean => {
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [pts[tris[t]!]!, pts[tris[t + 1]!]!, pts[tris[t + 2]!]!];
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    const a2 = a[0] ** 2 + a[1] ** 2;
    const b2 = b[0] ** 2 + b[1] ** 2;
    const c2 = c[0] ** 2 + c[1] ** 2;
    const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    const r = Math.hypot(a[0] - ux, a[1] - uy);
    for (let i = 0; i < pts.length; i++) {
      if (i === tris[t] || i === tris[t + 1] || i === tris[t + 2]) continue;
      if (Math.hypot(pts[i]![0] - ux, pts[i]![1] - uy) < r * (1 - 1e-7)) return false;
    }
  }
  return true;
};

describe('Delaunay triangulation', () => {
  it('splits a square into two triangles that tile it', () => {
    const pts: Point[] = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ];
    const tris = delaunay(pts)!;
    expect(tris).toHaveLength(6);
    let area = 0;
    for (let t = 0; t < 6; t += 3)
      area += signedArea([pts[tris[t]!]!, pts[tris[t + 1]!]!, pts[tris[t + 2]!]!]);
    expect(area).toBeCloseTo(12, 9);
  });

  it('is counter-clockwise, tiles the hull and keeps circumcircles empty (random sets)', () => {
    const r = rng(42);
    for (let k = 0; k < 40; k++) {
      const n = 3 + Math.floor(r() * 30);
      const pts: Point[] = Array.from({ length: n }, () => [r() * 12, r() * 9]);
      const tris = delaunay(pts)!;
      expect(tris).not.toBeNull();
      let area = 0;
      for (let t = 0; t < tris.length; t += 3) {
        const a = signedArea([pts[tris[t]!]!, pts[tris[t + 1]!]!, pts[tris[t + 2]!]!]);
        expect(a).toBeGreaterThan(0);
        area += a;
      }
      const hull = convexHull(pts);
      expect(area).toBeCloseTo(signedArea(hull.map((i) => pts[i]!)), 6);
      expect(circumcircleEmpty(pts, tris)).toBe(true);
      // Euler: triangles = 2n - 2 - hull vertices (no collinear hull points in random data).
      expect(tris.length / 3).toBe(2 * n - 2 - hull.length);
    }
  });

  it('copes with a regular grid (many co-circular points) and with large coordinates', () => {
    const grid: Point[] = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) grid.push([i, j]);
    const tris = delaunay(grid)!;
    expect(tris.length / 3).toBe(4 * 3 * 2);
    const far = grid.map(([x, y]): Point => [x * 0.5 + 1e4, y * 0.5 - 2e4]);
    expect(delaunay(far)!.length / 3).toBe(24);
  });

  it('returns null for fewer than three points or a single spot', () => {
    expect(delaunay([[0, 0]])).toBeNull();
    expect(
      delaunay([
        [1, 1],
        [1, 1],
        [1, 1],
      ]),
    ).toBeNull();
  });
});

describe('sensor layouts', () => {
  it('has nothing to show without sensors', () => {
    const mesh = buildMesh([]);
    expect(mesh.mode).toBe('none');
    expect(mesh.nodes).toEqual([]);
  });

  it('is flat with one sensor', () => {
    const mesh = buildMesh([[2, 3]]);
    expect(mesh.mode).toBe('flat');
    expect(mesh.nodes).toEqual([[2, 3]]);
  });

  it('merges sensors at the same spot into their mean', () => {
    const mesh = buildMesh([
      [1, 1],
      [1, 1.0002],
      [5, 1],
    ]);
    expect(mesh.mode).toBe('segment');
    expect(mesh.nodes).toHaveLength(2);
    expect(Array.from(nodeValues(mesh, [20, 22, 30]))).toEqual([21, 30]);
    const same = buildMesh([
      [1, 1],
      [1, 1],
    ]);
    expect(same.mode).toBe('flat');
    expect(Array.from(nodeValues(same, [20, 24]))).toEqual([22]);
  });

  it('falls back to segment mode for (nearly) collinear sensors', () => {
    const line = buildMesh([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(line.mode).toBe('segment');
    expect(line.nodes).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    // 10 cm off a 10 m line is still a line.
    const nearly = buildMesh([
      [0, 0],
      [5, 0.1],
      [10, 0],
    ]);
    expect(nearly.mode).toBe('segment');
    // Off-line sensors are projected onto it, and out of order input is chained along it.
    expect(nearly.nodes.every(([, y]) => Math.abs(y - 0.1 / 3) < 1e-9)).toBe(true);
    const shuffled = buildMesh([
      [10, 10],
      [0, 0],
      [5, 5],
    ]);
    expect(shuffled.members).toEqual([[1], [2], [0]]);
    // A proper triangle is not.
    expect(
      buildMesh([
        [0, 0],
        [5, 2],
        [10, 0],
      ]).mode,
    ).toBe('mesh');
  });

  it('ignores sensors without a finite position', () => {
    expect(
      buildMesh([
        [NaN, 1],
        [2, 2],
      ]).mode,
    ).toBe('flat');
  });
});

describe('confidence, fade and the grid', () => {
  const outline: Point[] = [
    [0, 0],
    [10, 0],
    [10, 8],
    [0, 8],
  ];

  it('is full inside the house and fades outside it', () => {
    expect(fadeAt(outline, 5, 4)).toBe(1);
    expect(fadeAt(outline, -1e-6, 4)).toBeCloseTo(OUTSIDE_ALPHA, 4);
    expect(fadeAt(outline, -1.25, 4)).toBeCloseTo(OUTSIDE_ALPHA / 2, 6);
    expect(fadeAt(outline, -5, 4)).toBe(0);
    expect(fadeAt([], -5, 4)).toBe(1);
  });

  it('samples cell centres and matches the reference everywhere', () => {
    const grid = fieldGrid({ minX: 0, minY: 0, maxX: 10, maxY: 8 }, 2, 30);
    expect(grid.nx).toBe(30);
    expect(grid.cell).toBeCloseTo(14 / 30, 12);
    expect(grid.ny).toBe(Math.ceil(12 / grid.cell));
    const pts: Point[] = [
      [1, 1],
      [9, 1.5],
      [5, 7],
      [2, 6],
    ];
    const vals = [18, 23, 26, 20];
    const { mesh, plan } = planField(pts, grid, outline);
    const field = fillField(plan, nodeValues(mesh, vals));
    for (let j = 0; j < grid.ny; j += 3)
      for (let i = 0; i < grid.nx; i += 3) {
        const x = grid.x0 + (i + 0.5) * grid.cell;
        const y = grid.y0 + (j + 0.5) * grid.cell;
        const c = (j * grid.nx + i) * 3;
        expect(field[c + 2]).toBeCloseTo(fadeAt(outline, x, y), 5);
        // Without walls every cell inside sees every sensor: plain inverse distance.
        if (field[c + 2] === 1) {
          expect(field[c]).toBeCloseTo(
            openField(mesh.nodes, nodeValues(mesh, vals), x, y, grid.cell),
            4,
          );
          const nearest = Math.min(...mesh.nodes.map(([nx, ny]) => Math.hypot(x - nx, y - ny)));
          expect(field[c + 1]).toBeCloseTo(
            1 - (1 - CONF_MIN) * smoothstep(CONF_NEAR, CONF_FAR, nearest),
            5,
          );
        } else expect(field[c + 1]).toBe(NO_DATA);
      }
  });

  it('has no data anywhere when there are no sensors', () => {
    const grid = fieldGrid({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 0, 4);
    const { plan } = planField([], grid, []);
    expect(Array.from(fillField(plan, [])).every((v, i) => v === [0, NO_DATA, 1][i % 3])).toBe(
      true,
    );
  });
});
