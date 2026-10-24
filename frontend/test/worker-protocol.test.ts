import { describe, expect, it } from 'vite-plus/test';
import { evalField, fieldGrid } from '../src/field';
import { MAX_FIELD_SIZE, WORKER_VERSION, createHandler } from '../src/worker-protocol';
import type { Point } from '../src/plan';

describe('worker protocol', () => {
  it('answers a ping', () => {
    expect(createHandler()({ type: 'ping', id: 7 })).toEqual({
      type: 'pong',
      id: 7,
      version: WORKER_VERSION,
    });
  });

  it('triangulates once, then turns values into a field grid', () => {
    const handle = createHandler();
    const sensors: Point[] = [
      [0, 0],
      [4, 0],
      [2, 3],
    ];
    const grid = fieldGrid({ minX: 0, minY: 0, maxX: 4, maxY: 3 }, 1, 16);
    const mesh = handle({ type: 'mesh', id: 1, key: 'a', sensors, outline: [], grid });
    expect(mesh.type).toBe('mesh');
    if (mesh.type !== 'mesh') return;
    expect(mesh.mesh.mode).toBe('mesh');
    const res = handle({ type: 'values', id: 2, key: 'a', values: [25, 30, 20] });
    expect(res.type).toBe('field');
    if (res.type !== 'field') return;
    expect(res.field).toHaveLength(grid.nx * grid.ny * 3);
    const i = 5;
    const j = 7;
    const x = grid.x0 + (i + 0.5) * grid.cell;
    const y = grid.y0 + (j + 0.5) * grid.cell;
    expect(res.field[(j * grid.nx + i) * 3]).toBeCloseTo(
      evalField(mesh.mesh, [25, 30, 20], x, y),
      4,
    );
  });

  it('rejects values for another layout, too few values and bad grids', () => {
    const handle = createHandler();
    expect(handle({ type: 'values', id: 1, key: 'x', values: [] }).type).toBe('error');
    const grid = fieldGrid({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 0, 4);
    handle({
      type: 'mesh',
      id: 2,
      key: 'k',
      sensors: [
        [0, 0],
        [1, 1],
      ],
      outline: [],
      grid,
    });
    expect(handle({ type: 'values', id: 3, key: 'other', values: [1, 2] }).type).toBe('error');
    expect(handle({ type: 'values', id: 4, key: 'k', values: [1] }).type).toBe('error');
    for (const nx of [0, 1.5, MAX_FIELD_SIZE + 1]) {
      expect(
        handle({ type: 'mesh', id: 5, key: 'k', sensors: [], outline: [], grid: { ...grid, nx } })
          .type,
      ).toBe('error');
    }
  });
});
