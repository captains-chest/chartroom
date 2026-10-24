import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { PLAN_SCHEMA_VERSION } from '../src/plan/constants';
import { pointAlong, validatePlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import type { Point } from '../src/plan/types';
import { polygonArea } from '../src/geometry';
import { planToSvg } from '../src/plan-svg';

interface Fixture extends Plan {
  meta: { stated_areas_m2: Record<string, number>; stated_total_m2: number };
}

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const plan = JSON.parse(read('./fixtures/example-plan.json')) as Fixture;

function inside([x, y]: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe('example plan fixture', () => {
  it('is a valid plan at the current schema version', () => {
    expect(plan.schema_version).toBe(PLAN_SCHEMA_VERSION);
    expect(validatePlan(plan)).toEqual([]);
  });

  it.each(Object.entries(plan.meta.stated_areas_m2))(
    'room %s is within 5%% of its stated area (%f m²)',
    (id, stated) => {
      const room = plan.rooms.find((r) => r.id === id);
      expect(room, id).toBeDefined();
      const traced = polygonArea(room!.polygon);
      expect(Math.abs(traced - stated) / stated).toBeLessThan(0.05);
    },
  );

  it('totals about 62 m²', () => {
    const total = plan.rooms.reduce((s, r) => s + polygonArea(r.polygon), 0);
    expect(Math.abs(total - plan.meta.stated_total_m2) / plan.meta.stated_total_m2).toBeLessThan(
      0.05,
    );
    // The rooms fit inside the envelope.
    expect(total).toBeLessThan(polygonArea(plan.outline));
  });

  it('has thick exterior walls and thin partitions', () => {
    const exterior = plan.walls.filter((w) => w.material === 'exterior');
    const partitions = plan.walls.filter((w) => w.material === 'partition');
    expect(exterior.length).toBeGreaterThan(0);
    expect(partitions.length).toBeGreaterThan(0);
    expect(Math.max(...exterior.map((w) => w.thickness))).toBeGreaterThan(0.4);
    expect(Math.max(...partitions.map((w) => w.thickness))).toBeLessThan(0.25);
  });

  it('swings every door into a room', () => {
    const walls = new Map(plan.walls.map((w) => [w.id, w]));
    for (const door of plan.doors) {
      const wall = walls.get(door.wall)!;
      const mid = pointAlong(wall, door.offset + door.width / 2);
      const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
      const n: Point = [
        (-(wall.b[1] - wall.a[1]) / len) * door.swing,
        ((wall.b[0] - wall.a[0]) / len) * door.swing,
      ];
      const probe: Point = [mid[0] + n[0] * 0.5, mid[1] + n[1] * 0.5];
      expect(
        plan.rooms.some((r) => inside(probe, r.polygon)),
        door.id,
      ).toBe(true);
    }
  });

  it('places every sample sensor inside a room', () => {
    for (const s of plan.sources) {
      expect(
        plan.rooms.some((r) => inside(s.position, r.polygon)),
        s.id,
      ).toBe(true);
    }
  });

  it('matches the committed SVG preview (run scripts/example-plan/render-svg.mjs)', () => {
    expect(planToSvg(plan)).toBe(read('../../docs/images/example-plan.svg'));
  });
});
