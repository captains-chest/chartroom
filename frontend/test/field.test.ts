import { describe, expect, it } from 'vite-plus/test';
import { openField } from './open-field';
import {
  OUTSIDE_ALPHA,
  buildMesh,
  confidenceAt,
  convexHull,
  delaunay,
  evalField,
  fadeAt,
  fieldGrid,
  hullEdges,
  nearestEdge,
  nodeValues,
  polygonArea,
} from '../src/field';
import { NO_DATA, fillField, planField } from '../src/field-plan';
import type { Point } from '../src/plan';

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
      area += polygonArea([pts[tris[t]!]!, pts[tris[t + 1]!]!, pts[tris[t + 2]!]!]);
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
        const a = polygonArea([pts[tris[t]!]!, pts[tris[t + 1]!]!, pts[tris[t + 2]!]!]);
        expect(a).toBeGreaterThan(0);
        area += a;
      }
      const hull = convexHull(pts);
      expect(area).toBeCloseTo(polygonArea(hull.map((i) => pts[i]!)), 6);
      expect(circumcircleEmpty(pts, tris)).toBe(true);
      // Euler: triangles = 2n - 2 - hull vertices (no collinear hull points in random data).
      expect(tris.length / 3).toBe(2 * n - 2 - hull.length);
      expect(hullEdges(tris).length / 2).toBe(hull.length);
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

describe('interpolation', () => {
  it('is exactly 27.5° halfway between a 25° and a 30° sensor', () => {
    const mesh = buildMesh([
      [0, 0],
      [4, 0],
    ]);
    expect(mesh.mode).toBe('segment');
    expect(evalField(mesh, [25, 30], 2, 0)).toBe(27.5);
    // Off the line too: segment mode projects onto it.
    expect(evalField(mesh, [25, 30], 2, 1.7)).toBeCloseTo(27.5, 12);
  });

  it('clamps beyond the ends of a two-sensor segment', () => {
    const mesh = buildMesh([
      [0, 0],
      [4, 0],
    ]);
    expect(evalField(mesh, [25, 30], -3, 0)).toBeCloseTo(25, 12);
    expect(evalField(mesh, [25, 30], 9, -2)).toBeCloseTo(30, 12);
    expect(evalField(mesh, [25, 30], 1, 0)).toBeCloseTo(26.25, 12);
  });

  it('is barycentric (linear) inside triangles and exact at the sensors', () => {
    const pts: Point[] = [
      [0, 0],
      [6, 0],
      [0, 6],
      [6, 6],
      [3, 2],
    ];
    // A linear field is reproduced exactly by barycentric interpolation.
    const f = (x: number, y: number): number => 18 + 0.5 * x - 0.25 * y;
    const vals = pts.map(([x, y]) => f(x, y));
    const mesh = buildMesh(pts);
    expect(mesh.mode).toBe('mesh');
    for (const [x, y] of [
      [1, 1],
      [3, 3],
      [5.5, 0.5],
      [2.9, 5.9],
    ] as Point[])
      expect(evalField(mesh, vals, x, y)).toBeCloseTo(f(x, y), 10);
    pts.forEach(([x, y], i) => expect(evalField(mesh, vals, x, y)).toBeCloseTo(vals[i]!, 10));
    // Halfway along a triangle edge between 25 and 30: 27.5.
    const tri = buildMesh([
      [0, 0],
      [4, 0],
      [2, 3],
    ]);
    expect(evalField(tri, [25, 30, 20], 2, 0)).toBeCloseTo(27.5, 12);
  });
});

describe('outside the hull', () => {
  const pts: Point[] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  const vals = [20, 24, 28, 22];
  const mesh = buildMesh(pts);

  it('projects onto the nearest hull edge and lerps along it', () => {
    // Below the bottom edge, a quarter of the way along: 20 + (24-20)/4.
    expect(evalField(mesh, vals, 1, -2)).toBeCloseTo(21, 12);
    const e = nearestEdge(mesh, 1, -2);
    expect(e.t).toBeCloseTo(0.25, 12);
    expect(Math.sqrt(e.d2)).toBeCloseTo(2, 12);
    // Right of the right edge, halfway up: (24+28)/2.
    expect(evalField(mesh, vals, 7, 2)).toBeCloseTo(26, 12);
  });

  it('clamps to the corner value beyond a hull vertex', () => {
    expect(evalField(mesh, vals, 6, 7)).toBeCloseTo(28, 12);
    expect(evalField(mesh, vals, -1, -1)).toBeCloseTo(20, 12);
  });

  it('is continuous across the hull boundary', () => {
    for (const [x, y] of [
      [2, 0],
      [4, 1.3],
      [0.5, 4],
    ] as Point[]) {
      const inside = evalField(
        mesh,
        vals,
        x + (x === 4 ? -1e-7 : 0),
        y + (y === 0 ? 1e-7 : y === 4 ? -1e-7 : 0),
      );
      const outside = evalField(
        mesh,
        vals,
        x + (x === 4 ? 1e-7 : 0),
        y + (y === 0 ? -1e-7 : y === 4 ? 1e-7 : 0),
      );
      expect(Math.abs(inside - outside)).toBeLessThan(1e-5);
    }
  });

  it('builds the hull as counter-clockwise boundary edges', () => {
    expect(mesh.edges.length / 2).toBe(4);
  });
});

describe('degenerate layouts', () => {
  it('has nothing to show without sensors', () => {
    const mesh = buildMesh([]);
    expect(mesh.mode).toBe('none');
    expect(evalField(mesh, [], 0, 0)).toBeNaN();
  });

  it('is flat with one sensor', () => {
    const mesh = buildMesh([[2, 3]]);
    expect(mesh.mode).toBe('flat');
    expect(evalField(mesh, [21.4], -10, 50)).toBe(21.4);
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
    expect(evalField(same, [20, 24], 9, 9)).toBe(22);
  });

  it('falls back to segment mode for (nearly) collinear sensors', () => {
    const line = buildMesh([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(line.mode).toBe('segment');
    expect(line.edges).toEqual([0, 1, 1, 2]);
    expect(evalField(line, [20, 25, 21], 7.5, 3)).toBeCloseTo(23, 12);
    // 10 cm off a 10 m line is still a line.
    const nearly = buildMesh([
      [0, 0],
      [5, 0.1],
      [10, 0],
    ]);
    expect(nearly.mode).toBe('segment');
    // Out of order input is chained along the line.
    const shuffled = buildMesh([
      [10, 10],
      [0, 0],
      [5, 5],
    ]);
    expect(evalField(shuffled, [30, 20, 22], 7.5, 7.5)).toBeCloseTo(26, 10);
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

  it('trusts the field near sensors and fades it far away', () => {
    const mesh = buildMesh([[1, 1]]);
    expect(confidenceAt(mesh, 1, 2)).toBe(1);
    expect(confidenceAt(mesh, 1, 30)).toBeCloseTo(0.3, 9);
    const mid = confidenceAt(mesh, 1, 6.5);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(1);
  });

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
          expect(field[c + 1]).toBeCloseTo(confidenceAt(mesh, x, y), 5);
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
