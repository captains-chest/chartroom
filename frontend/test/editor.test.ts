import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { exteriorLoop, outlineFromWalls, polygonArea, solidSpans } from '../src/geometry';
import { History } from '../src/history';
import { emptyPlan, normalizePlan, validatePlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import {
  addOpening,
  addRoom,
  addWall,
  areaFactor,
  deleteOpening,
  deleteRoom,
  deleteWall,
  moveEndpoint,
  moveOpening,
  moveRoomVertex,
  moveWall,
  nextId,
  scalePlan,
  twoPointFactor,
  updateOpening,
  updateRoom,
  updateWall,
  wallAt,
} from '../src/plan/ops';
import { snap, snapTargets } from '../src/editor/snap';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/example-plan.json', import.meta.url), 'utf8'),
) as Plan;

/** A 4 x 3 m box of exterior walls, drawn clockwise (y down). */
function box(): Plan {
  let plan = emptyPlan('Box');
  const corners: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ];
  for (let i = 0; i < 4; i++) {
    plan = addWall(plan, corners[i]!, corners[(i + 1) % 4]!, {
      material: 'exterior',
      thickness: 0.2,
    }).plan;
  }
  return plan;
}

describe('outline', () => {
  it('rebuilds the example fixture outline from its exterior walls', () => {
    const outline = outlineFromWalls(fixture);
    expect(outline).toHaveLength(fixture.outline.length);
    for (const [i, p] of outline.entries()) {
      expect(p[0]).toBeCloseTo(fixture.outline[i]![0], 2);
      expect(p[1]).toBeCloseTo(fixture.outline[i]![1], 2);
    }
  });

  it('pushes a closed loop outward by half the thickness', () => {
    expect(box().outline).toEqual([
      [-0.1, -0.1],
      [4.1, -0.1],
      [4.1, 3.1],
      [-0.1, 3.1],
    ]);
    expect(polygonArea(box().outline)).toBeCloseTo(4.2 * 3.2, 6);
  });

  it('falls back to the bounding box, and to nothing without walls', () => {
    const open = deleteWall(box(), 'wall_4');
    expect(exteriorLoop(open.walls)).toBeNull();
    expect(open.outline).toEqual([
      [-0.1, -0.1],
      [4.1, -0.1],
      [4.1, 3.1],
      [-0.1, 3.1],
    ]);
    expect(outlineFromWalls(emptyPlan('x'))).toEqual([]);
    expect(validatePlan(emptyPlan('x'))).toEqual([]);
  });
});

describe('walls', () => {
  it('ignores walls that are too short and gives fresh ids', () => {
    const plan = box();
    expect(addWall(plan, [1, 1], [1.01, 1]).id).toBeNull();
    expect(nextId(plan, 'wall')).toBe('wall_5');
    expect(validatePlan(plan)).toEqual([]);
  });

  it('moves a corner of every wall joined there', () => {
    const plan = moveEndpoint(box(), [4, 0], [5, -1]);
    expect(plan.walls[0]!.b).toEqual([5, -1]);
    expect(plan.walls[1]!.a).toEqual([5, -1]);
    expect(plan.walls[2]!.a).toEqual([4, 3]);
    expect(exteriorLoop(plan.walls)).not.toBeNull();
  });

  it('drags joined walls along when a wall moves', () => {
    const plan = moveWall(box(), 'wall_2', [1, 0]);
    expect(plan.walls[1]).toMatchObject({ a: [5, 0], b: [5, 3] });
    expect(plan.walls[0]!.b).toEqual([5, 0]);
    expect(plan.walls[2]!.a).toEqual([5, 3]);
    expect(plan.outline[1]).toEqual([5.1, -0.1]);
  });

  it('changes material and thickness, and deletes a wall with its openings', () => {
    let plan = updateWall(box(), 'wall_1', { material: 'partition', thickness: 0.004 });
    expect(plan.walls[0]).toMatchObject({ material: 'partition', thickness: 0.01 });
    plan = addOpening(plan, 'door', 'wall_3', 2).plan;
    plan = deleteWall(plan, 'wall_3');
    expect(plan.walls.map((w) => w.id)).toEqual(['wall_1', 'wall_2', 'wall_4']);
    expect(plan.doors).toEqual([]);
  });

  it('finds the wall under a point, measured to its face', () => {
    expect(wallAt(box(), [2, 0.15], 0.06)?.wall.id).toBe('wall_1');
    expect(wallAt(box(), [2, 0.15], 0.01)).toBeNull();
    expect(wallAt(box(), [4.05, 1], 0)?.along).toBeCloseTo(1, 6);
  });
});

describe('openings', () => {
  it('places doors and windows centred on the click and keeps them inside the wall', () => {
    let { plan, id } = addOpening(box(), 'door', 'wall_1', 0.1, [0.1, 0.5]);
    expect(id).toBe('door_1');
    expect(plan.doors[0]).toMatchObject({ offset: 0, width: 0.8, hinge: 'a', swing: 1 });
    plan = addOpening(plan, 'window', 'wall_1', 3, [3, -1]).plan;
    expect(plan.windows[0]).toMatchObject({
      id: 'window_1',
      offset: 2.4,
      width: 1.2,
      material: 'glass',
    });
    const spans = solidSpans(plan.walls[0]!, [...plan.doors, ...plan.windows]);
    expect(spans.flat().map((v) => Math.round(v * 1000) / 1000)).toEqual([0.8, 2.4, 3.6, 4]);
    plan = moveOpening(plan, 'window_1', 10);
    expect(plan.windows[0]!.offset).toBe(2.8);
    plan = moveEndpoint(plan, [4, 0], [3, 0]);
    expect(plan.windows[0]).toMatchObject({ offset: 1.8, width: 1.2 });
  });

  it('swings doors towards the clicked side and edits keep the centre', () => {
    let plan = addOpening(box(), 'door', 'wall_1', 2, [2, -0.5]).plan;
    expect(plan.doors[0]!.swing).toBe(-1);
    plan = updateOpening(plan, 'door_1', { width: 1, hinge: 'b' });
    expect(plan.doors[0]).toMatchObject({ offset: 1.5, width: 1, hinge: 'b' });
    expect(deleteOpening(plan, 'door_1').doors).toEqual([]);
  });
});

describe('rooms', () => {
  it('adds, links, reshapes and deletes rooms', () => {
    let { plan, id } = addRoom(box(), [
      [0, 0],
      [4, 0],
      [4, 3],
    ]);
    expect(id).toBe('room_1');
    plan = updateRoom(plan, 'room_1', { name: 'Kitchen', area_ids: ['kitchen'] });
    expect(plan.rooms[0]).toMatchObject({ name: 'Kitchen', area_ids: ['kitchen'] });
    plan = updateRoom(plan, 'room_1', { area_ids: ['kitchen', 'living_room', 'kitchen', ''] });
    expect(plan.rooms[0]!.area_ids).toEqual(['kitchen', 'living_room']);
    plan = updateRoom(plan, 'room_1', { name: 'Open plan' });
    expect(plan.rooms[0]!.area_ids).toEqual(['kitchen', 'living_room']);
    plan = updateRoom(plan, 'room_1', { area_ids: [] });
    expect(plan.rooms[0]).not.toHaveProperty('area_ids');
    plan = moveRoomVertex(plan, 'room_1', 2, [0, 3]);
    expect(plan.rooms[0]!.polygon[2]).toEqual([0, 3]);
    expect(addRoom(plan, [[0, 0]]).id).toBeNull();
    expect(deleteRoom(plan, 'room_1').rooms).toEqual([]);
  });
});

describe('calibration', () => {
  it('scales from a measured distance', () => {
    const k = twoPointFactor([0, 0], [2, 0], 5);
    expect(k).toBe(2.5);
    const plan = scalePlan(box(), k);
    expect(plan.walls[0]).toMatchObject({ a: [0, 0], b: [10, 0], thickness: 0.2 });
    expect(() => twoPointFactor([1, 1], [1, 1], 2)).toThrow();
  });

  it('scales from a known room area, including openings and the underlay', () => {
    let plan = addRoom(box(), [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]).plan;
    plan = addOpening(plan, 'door', 'wall_1', 2).plan;
    plan = {
      ...plan,
      underlay: {
        url: '/x',
        width_px: 100,
        height_px: 50,
        scale: 0.05,
        origin: [1, 1],
        opacity: 0.5,
      },
    };
    const k = areaFactor(plan.rooms[0]!.polygon, 48);
    expect(k).toBeCloseTo(2, 9);
    plan = scalePlan(plan, k);
    expect(polygonArea(plan.rooms[0]!.polygon)).toBeCloseTo(48, 6);
    expect(plan.doors[0]).toMatchObject({ offset: 3.2, width: 1.6, thickness: 0.04 });
    expect(plan.underlay).toMatchObject({ scale: 0.1, origin: [2, 2] });
    expect(() => scalePlan(plan, 0)).toThrow();
  });
});

describe('snapping', () => {
  const targets = snapTargets(box(), true);

  it('prefers nearby corners and wall faces', () => {
    expect(snap([3.98, 0.03], { radius: 0.1, grid: 0.1, targets })).toEqual({
      point: [4, 0],
      target: true,
    });
    expect(snap([3.88, 0.12], { radius: 0.05, grid: 0.1, targets })).toEqual({
      point: [3.9, 0.1],
      target: true,
    });
  });

  it('falls back to the grid and straightens nearly level lines', () => {
    expect(snap([1.234, 1.98], { radius: 0.05, grid: 0.05, targets: [] }).point).toEqual([1.25, 2]);
    expect(snap([3, 2.1], { radius: 0, grid: 0.05, targets: [], anchor: [0, 2] }).point).toEqual([
      3, 2,
    ]);
    expect(snap([4, 4], { radius: 1, grid: 0.05, targets: [[4, 4]], exclude: [4, 4] }).target).toBe(
      false,
    );
  });
});

describe('History', () => {
  it('undoes and redoes, and a new commit drops the redo branch', () => {
    const h = new History('a', 2);
    expect(h.commit('a')).toBe(false);
    h.commit('b');
    h.commit('c');
    h.commit('d');
    expect(h.undo()).toBe('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBe('c');
    h.commit('e');
    expect(h.canRedo).toBe(false);
    h.reset('z');
    expect([h.present, h.canUndo]).toEqual(['z', false]);
  });
});

describe('normalizePlan', () => {
  it('fills missing lists and keeps the stored id and extra keys', () => {
    const plan = normalizePlan({ id: 'p', name: 'P', walls: [], extra: 1 });
    expect(plan).toMatchObject({ id: 'p', name: 'P', floor_id: null, rooms: [], extra: 1 });
    expect(() => normalizePlan({ schema_version: 9, name: 'x' })).toThrow(/schema_version/);
    expect(() => normalizePlan(null)).toThrow();
  });

  it("folds a room's single area_id from older plans into area_ids", () => {
    const polygon = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const plan = normalizePlan({
      name: 'Old',
      rooms: [
        { id: 'a', name: 'A', polygon, area_id: 'kitchen' },
        { id: 'b', name: 'B', polygon, area_id: null },
        { id: 'c', name: 'C', polygon },
        { id: 'd', name: 'D', polygon, area_ids: ['living_room'], area_id: 'kitchen' },
        { id: 'e', name: 'E', polygon, area_ids: ['hall', 'hall', ''], area_id: 'hall' },
        { id: 'f', name: 'F', polygon, area_ids: [] },
      ],
    });
    expect(plan.rooms.map((r) => r.area_ids)).toEqual([
      ['kitchen'],
      undefined,
      undefined,
      ['living_room', 'kitchen'],
      ['hall'],
      undefined,
    ]);
    for (const r of plan.rooms) expect(r).not.toHaveProperty('area_id');
    expect(plan.rooms[0]).toEqual({ id: 'a', name: 'A', polygon, area_ids: ['kitchen'] });
    expect(validatePlan(plan)).toEqual([]);
  });
});
