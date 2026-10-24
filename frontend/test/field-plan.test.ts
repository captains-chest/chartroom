import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { fieldGrid, nodeValues, type FieldGrid } from '../src/field';
import {
  NO_DATA,
  THROUGH_OPENING,
  barrierCells,
  fillField,
  planField,
  visibility,
} from '../src/field-plan';
import type { Plan, Point } from '../src/plan';
import { barrierSegments } from '../src/signal';

/** A 10 x 4 m box split at x = 5 by a wall (optionally with a door gap from y = 1.5 to 2.5). */
const box: Point[] = [
  [0, 0],
  [10, 0],
  [10, 4],
  [0, 4],
];
const grid = fieldGrid({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, 0.5, 220);
const sensors: Point[] = [
  [2.5, 2],
  [7.5, 2],
];
const vals = [20, 30];
const wall = [5, 0, 5, 4];
const wallWithGap = [5, 0, 5, 1.5, 5, 2.5, 5, 4];

const cellAt = (g: FieldGrid, x: number, y: number): number =>
  Math.floor((y - g.y0) / g.cell) * g.nx + Math.floor((x - g.x0) / g.cell);

function sample(walls: number[], rooms: Point[][] = [], pts = sensors, v = vals) {
  const { mesh, plan } = planField(pts, grid, box, walls, rooms);
  const field = fillField(plan, nodeValues(mesh, v));
  return {
    plan,
    value: (x: number, y: number) => field[cellAt(grid, x, y) * 3]!,
    conf: (x: number, y: number) => field[cellAt(grid, x, y) * 3 + 1]!,
  };
}

describe('walls are boundaries for temperature and humidity', () => {
  it('blends linearly with no wall: 25 halfway between 20 and 30', () => {
    const f = sample([]);
    expect(f.value(5, 2)).toBeCloseTo(25, 1);
    expect(f.value(3.75, 2)).toBeCloseTo(22.5, 1);
  });

  it('stops at a wall: ~20 on one side, ~30 on the other, with a sharp edge', () => {
    const f = sample(wall);
    for (const y of [0.3, 2, 3.7]) {
      expect(f.value(1, y)).toBeCloseTo(20, 5);
      expect(f.value(4.9, y)).toBeCloseTo(20, 5);
      expect(f.value(5.1, y)).toBeCloseTo(30, 5);
      expect(f.value(9, y)).toBeCloseTo(30, 5);
    }
    // The whole step happens within one cell of the wall.
    const step = grid.cell * 1.01;
    expect(f.value(5 - step, 2)).toBeCloseTo(20, 5);
    expect(f.value(5 + step, 2)).toBeCloseTo(30, 5);
  });

  it('lets values through an open doorway but not a closed one', () => {
    const plan: Plan = {
      schema_version: 1,
      name: 'test',
      floor_id: null,
      outline: box,
      walls: [{ id: 'mid', a: [5, 0], b: [5, 4], thickness: 0.1, material: 'brick' }],
      rooms: [],
      doors: [
        {
          id: 'd',
          wall: 'mid',
          offset: 1.5,
          width: 1,
          material: 'wood_door',
          thickness: 0.04,
          hinge: 'a',
          swing: 1,
          entity_id: 'binary_sensor.door',
        },
      ],
      windows: [],
      sources: [],
    } as unknown as Plan;
    const states = (state: string) => ({
      states: { 'binary_sensor.door': { entity_id: 'binary_sensor.door', state } },
    });
    const open = barrierSegments(plan, states('on') as never);
    const closed = barrierSegments(plan, states('off') as never);
    const unknown = barrierSegments(plan, undefined);
    expect(open).toEqual(wallWithGap);
    expect(unknown).toEqual(wallWithGap); // no state: a doorway
    expect(closed).toEqual([...wallWithGap.slice(0, 4), 5, 1.5, 5, 2.5, ...wallWithGap.slice(4)]);
    // One sensor on the left; the right room has none.
    const one: Point[] = [[2.5, 2]];
    const shut = sample(closed, [], one, [20]);
    expect(shut.conf(7.5, 2)).toBe(NO_DATA);
    expect(shut.conf(7.5, 0.5)).toBe(NO_DATA);
    const through = sample(open, [], one, [20]);
    // Straight through the doorway: seen directly. Off to the side: carried round the jamb.
    expect(through.value(7.5, 2)).toBeCloseTo(20, 5);
    expect(through.value(7.5, 0.3)).toBeCloseTo(20, 5);
    expect(through.conf(7.5, 0.3)).toBeGreaterThan(0);
    expect(through.conf(7.5, 0.3)).toBeLessThanOrEqual(THROUGH_OPENING);
    // Two sensors, door open: each room keeps its own sensor (flat) when rooms are known.
    const rooms: Point[][] = [
      [
        [0, 0],
        [5, 0],
        [5, 4],
        [0, 4],
      ],
      [
        [5, 0],
        [10, 0],
        [10, 4],
        [5, 4],
      ],
    ];
    const both = sample(open, rooms);
    expect(both.value(4.8, 2)).toBeCloseTo(20, 5);
    expect(both.value(5.2, 2)).toBeCloseTo(30, 5);
  });

  it('fills a sensorless room through its doorway, fainter further in', () => {
    const rooms: Point[][] = [
      [
        [0, 0],
        [5, 0],
        [5, 4],
        [0, 4],
      ],
      [
        [5, 0],
        [10, 0],
        [10, 4],
        [5, 4],
      ],
    ];
    const f = sample(wallWithGap, rooms, [[2.5, 2]], [21]);
    for (const [x, y] of [
      [6, 0.3],
      [9.7, 3.7],
      [8, 2],
    ] as Point[]) {
      expect(f.value(x, y)).toBeCloseTo(21, 5);
      expect(f.conf(x, y)).toBeGreaterThan(0);
      expect(f.conf(x, y)).toBeLessThanOrEqual(THROUGH_OPENING);
    }
    expect(f.conf(9.7, 0.3)).toBeLessThan(f.conf(5.5, 2));
  });

  it('keeps open-room behaviour: linear among the sensors a cell sees, flat with one', () => {
    const rooms: Point[][] = [box];
    const f = sample([], rooms);
    expect(f.value(5, 2)).toBeCloseTo(25, 1);
    const flat = sample([], rooms, [[2.5, 2]], [19]);
    expect(flat.value(9, 3.5)).toBeCloseTo(19, 5);
  });

  it('shows no data outside the house and where nothing reaches', () => {
    const f = sample(wall, [], [[2.5, 2]], [20]);
    expect(f.conf(-0.2, 2)).toBe(NO_DATA);
    expect(f.conf(7, 2)).toBe(NO_DATA);
  });

  it('casts shadows exactly where a straight line crosses a wall', () => {
    const g = fieldGrid({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, 0, 40);
    const vis = visibility([[2.5, 2]], g, [5, 1, 5, 3]);
    const seg = (px: number, py: number) => {
      // Does (2.5, 2) -> (px, py) cross x = 5 between y 1 and 3?
      if (px <= 5) return false;
      const y = 2 + ((py - 2) * (5 - 2.5)) / (px - 2.5);
      return y >= 1 && y <= 3;
    };
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const x = g.x0 + (i + 0.5) * g.cell;
        const y = g.y0 + (j + 0.5) * g.cell;
        expect(vis[j * g.nx + i], `${x},${y}`).toBe(seg(x, y) ? 0 : 1);
      }
    const cells = barrierCells(g, [5.01, 0, 5.01, 4]);
    for (let j = 0; j < g.ny; j++) expect(cells[j * g.nx + 20]).toBe(1);
  });
});

describe('example plan', () => {
  const plan = JSON.parse(
    readFileSync(new URL('./fixtures/example-plan.json', import.meta.url), 'utf8'),
  ) as Plan;
  const g = fieldGrid({ minX: 0, minY: 0, maxX: 12, maxY: 10 }, 0.5, 160);
  const rooms = plan.rooms.map((r) => r.polygon);
  /** The example plan's temperature field with every door open or shut, minus some sensors. */
  function scenario(doors: 'open' | 'closed', drop: string[] = []) {
    const shut: Plan = {
      ...plan,
      doors: plan.doors.map((d) => ({ ...d, entity_id: `binary_sensor.${d.id}` })),
    };
    const hass = {
      states: Object.fromEntries(
        plan.doors.map((d) => [
          `binary_sensor.${d.id}`,
          { entity_id: `binary_sensor.${d.id}`, state: doors === 'open' ? 'on' : 'off' },
        ]),
      ),
    };
    const walls = barrierSegments(shut, hass as never);
    const pts = plan.sources
      .filter((s) => /temperature/.test(s.entity_id ?? '') && !drop.includes(s.id))
      .map((s) => s.position);
    return { walls, ...planField(pts, g, plan.outline, walls, rooms) };
  }
  const { walls, mesh } = scenario('open');
  const roomOf = (p: Point) =>
    plan.rooms.findIndex((r) => {
      let hit = false;
      const poly = r.polygon;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
        if (
          poly[i]![1] > p[1] !== poly[j]![1] > p[1] &&
          p[0] <
            ((poly[j]![0] - poly[i]![0]) * (p[1] - poly[i]![1])) / (poly[j]![1] - poly[i]![1]) +
              poly[i]![0]
        )
          hit = !hit;
      return hit;
    });
  const crosses = (walls: number[], a: Point, b: Point): boolean => {
    for (let k = 0; k < walls.length; k += 4) {
      const [cx, cy, dx, dy] = walls.slice(k, k + 4) as [number, number, number, number];
      const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
        Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
      if (
        o(a[0], a[1], b[0], b[1], cx, cy) * o(a[0], a[1], b[0], b[1], dx, dy) < 0 &&
        o(cx, cy, dx, dy, a[0], a[1]) * o(cx, cy, dx, dy, b[0], b[1]) < 0
      )
        return true;
    }
    return false;
  };

  it('has temperature sensors in several rooms', () => {
    expect(new Set(mesh.nodes.map(roomOf)).size).toBeGreaterThan(2);
  });

  function noLeaks({ walls, mesh, plan: fp }: ReturnType<typeof scenario>): number {
    const wallCells = barrierCells(g, walls);
    const vis = visibility(mesh.nodes, g, walls);
    const cells = g.nx * g.ny;
    const at = (p: Point) =>
      Math.floor((p[1] - g.y0) / g.cell) * g.nx + Math.floor((p[0] - g.x0) / g.cell);
    // Independent of the planner: which wall-free region each cell is in.
    const region = new Int32Array(cells).fill(-1);
    let regions = 0;
    for (let c0 = 0; c0 < cells; c0++) {
      if (region[c0] !== -1 || wallCells[c0]) continue;
      const stack = [c0];
      region[c0] = regions;
      while (stack.length) {
        const c = stack.pop()!;
        const i = c % g.nx;
        for (const n of [c - 1, c + 1, c - g.nx, c + g.nx]) {
          if (n < 0 || n >= cells || Math.abs((n % g.nx) - i) > 1) continue;
          if (region[n] !== -1 || wallCells[n]) continue;
          region[n] = regions;
          stack.push(n);
        }
      }
      regions++;
    }
    let checked = 0;
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const c = j * g.nx + i;
        if (fp.conf[c]! === NO_DATA || wallCells[c]) continue;
        const p: Point = [g.x0 + (i + 0.5) * g.cell, g.y0 + (j + 0.5) * g.cell];
        const room = roomOf(p);
        const own = mesh.nodes.map((_, k) => k).filter((k) => roomOf(mesh.nodes[k]!) === room);
        const used = [0, 1, 2]
          .filter((k) => fp.w[c * 3 + k]! > 1e-6)
          .map((k) => fp.idx[c * 3 + k]!);
        for (const k of used) {
          const node = mesh.nodes[k]!;
          // Every value comes from a sensor in the same wall-bounded region...
          expect(region[at(node)], `cell ${i},${j}`).toBe(region[c]);
          // ...seen in a straight line, or carried round a corner at reduced confidence.
          if (vis[k * cells + c]) expect(crosses(walls, p, node), `cell ${i},${j}`).toBe(false);
          else expect(fp.conf[c]!, `cell ${i},${j}`).toBeLessThanOrEqual(THROUGH_OPENING);
          // A room with a sensor of its own uses only its own sensors.
          if (room >= 0 && own.length > 0) expect(own, `cell ${i},${j}`).toContain(k);
        }
        checked++;
      }
    return regions;
  }

  it('never takes a value through a wall, doors open or shut', () => {
    expect(noLeaks(scenario('open'))).toBeGreaterThanOrEqual(1);
    // With every door shut each room is its own region (plus outside).
    expect(noLeaks(scenario('closed'))).toBeGreaterThan(plan.rooms.length);
    expect(noLeaks(scenario('open', ['office_temperature']))).toBeGreaterThanOrEqual(1);
  });

  it('fills a room without a sensor through its door, and shows no data once it is shut', () => {
    const inBedroom2: Point = [9, 6.4];
    const at = (p: Point) =>
      Math.floor((p[1] - g.y0) / g.cell) * g.nx + Math.floor((p[0] - g.x0) / g.cell);
    const open = scenario('open', ['office_temperature']).plan;
    expect(open.conf[at(inBedroom2)]!).toBeGreaterThan(0);
    expect(open.conf[at(inBedroom2)]!).toBeLessThanOrEqual(THROUGH_OPENING);
    const shut = scenario('closed', ['office_temperature']).plan;
    expect(shut.conf[at(inBedroom2)]).toBe(NO_DATA);
    // The other rooms keep their own sensors.
    expect(shut.conf[at([1.5, 2.4])]!).toBeGreaterThan(THROUGH_OPENING);
  });

  it('plans the example plan quickly', () => {
    const big = fieldGrid({ minX: 0, minY: 0, maxX: 12, maxY: 10 }, 2.5, 256);
    const t0 = performance.now();
    planField(mesh.nodes, big, plan.outline, walls, rooms);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
