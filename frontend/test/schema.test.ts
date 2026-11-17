import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { emptyPlan } from '../src/plan/functions';
import { normalizePlan, parsePlan, PLAN_LISTS, shapeProblems } from '../src/plan/schema';
import { planBody } from '../src/plan-svg';

const example = JSON.parse(
  readFileSync(new URL('./fixtures/example-plan.json', import.meta.url), 'utf8'),
) as unknown;

const polygon = [
  [0, 0],
  [1, 0],
  [1, 1],
];

describe('plan schema', () => {
  it('passes the example plan and an empty one', () => {
    expect(shapeProblems(normalizePlan(example))).toEqual([]);
    expect(shapeProblems(emptyPlan('x'))).toEqual([]);
  });

  it('describes every list of a plan', () => {
    expect(Object.keys(PLAN_LISTS)).toEqual([
      'walls',
      'doors',
      'windows',
      'rooms',
      'sources',
      'devices',
      'materials',
    ]);
  });

  it('fills missing (or null) lists but leaves materials out', () => {
    const plan = normalizePlan({ name: 'P', walls: null });
    expect(plan).toMatchObject({ walls: [], rooms: [], devices: [], outline: [] });
    expect(plan).not.toHaveProperty('materials');
  });

  it("checks a room's area_ids, after folding in the legacy area_id", () => {
    const rooms = [
      { id: 'a', name: 'A', polygon, area_id: 'kitchen' },
      { id: 'b', name: 'B', polygon, area_ids: 'hall' },
    ];
    // A single area_ids string is not a list: normalising drops it, so nothing is left to report.
    expect(shapeProblems(normalizePlan({ name: 'P', rooms }))).toEqual([]);
    const plan = normalizePlan({ name: 'P', rooms: [{ id: 'c', name: 'C', polygon }] });
    const bad = { ...plan, rooms: [{ id: 'c', name: 'C', polygon, area_ids: [1] }] };
    expect(shapeProblems(bad as never)).toEqual(['rooms[0]: bad or missing area_ids']);
  });

  it("checks a device's exclude, without repeats or its own entity, and caps its length", () => {
    const dev = { id: 'd', entity_id: 'light.a', device_id: 'x', position: [0, 0] };
    const plan = normalizePlan({
      name: 'P',
      devices: [
        { ...dev, exclude: ['sensor.t', 'sensor.t', 'light.a'] },
        { ...dev, id: 'e', exclude: ['light.a'] },
        { ...dev, id: 'f', exclude: Array.from({ length: 65 }, (_, i) => `sensor.s${i}`) },
      ],
    });
    expect(plan.devices!.slice(0, 2)).toEqual([
      { ...dev, exclude: ['sensor.t'] },
      { ...dev, id: 'e' },
    ]);
    expect(shapeProblems(plan)).toEqual(['devices[2]: bad or missing exclude']);
  });

  it('keeps a damaged list for shapeProblems to report, rather than throwing', () => {
    expect(() => normalizePlan({ name: 'P', rooms: 'none' })).not.toThrow();
    expect(() => normalizePlan({ name: 'P', rooms: [null, 3] })).not.toThrow();
    expect(parsePlan({ name: 'P', rooms: 'none' }).problems).toEqual(['rooms is not a list']);
  });

  it('refuses nothing and repairs nothing for a sound plan', () => {
    const raw = { id: 'p', name: 'P', walls: [], extra: 1 };
    const { plan, problems } = parsePlan(raw, { repair: true });
    expect(problems).toEqual([]);
    expect(plan).toMatchObject({ id: 'p', extra: 1 });
  });

  it('repairs a damaged stored plan so it still opens, without the items it cannot use', () => {
    const wall = { id: 'w', a: [0, 0], b: [1, 0], thickness: 0.1, material: 'exterior' };
    const raw = {
      name: 'Damaged',
      outline: 'x',
      walls: [
        wall,
        'junk',
        { ...wall, id: 'v', thickness: 'thick' },
        { ...wall, id: 'u', a: undefined },
      ],
      rooms: { a: 1 },
      doors: 5,
      underlay: 'pic.png',
      devices: [null],
    };
    const { plan, problems } = parsePlan(raw, { repair: true });
    expect(plan.outline).toEqual([]);
    expect(plan.walls.map((w) => w.id)).toEqual(['w']);
    // What is left draws.
    expect(() => planBody(plan)).not.toThrow();
    expect(plan.rooms).toEqual([]);
    expect(plan.doors).toEqual([]);
    expect(plan.devices).toEqual([]);
    expect(plan.underlay).toBe('pic.png');
    expect(problems).toEqual([
      'outline is not a list of points',
      'walls[1] is not an object',
      'walls[2]: bad or missing thickness',
      'walls[3]: bad or missing a',
      'doors is not a list',
      'rooms is not a list',
      'devices[0] is not an object',
      'underlay is not an object',
    ]);
    // Without repair the plan is left as it came, for the caller to refuse.
    expect(parsePlan(raw).plan.walls).toHaveLength(4);
  });
});
