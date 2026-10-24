import { describe, expect, it } from 'vite-plus/test';
import { findItem, KINDS, kindOps, titleOf } from '../src/editor/kinds';
import type { Kind } from '../src/editor/types';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { addDevice, addOpening, addRoom, addSource, addWall } from '../src/plan/ops';

/** One of each kind: a wall with a door and a window, a room, a source and a device. */
function plan(): Plan {
  let p = addWall(emptyPlan('Kinds'), [0, 0], [4, 0]).plan;
  p = addOpening(p, 'door', 'wall_1', 1).plan;
  p = addOpening(p, 'window', 'wall_1', 3).plan;
  p = addRoom(p, [
    [0, 0],
    [4, 0],
    [4, 3],
  ]).plan;
  p = addSource(p, 'sensor', [1, 1], 'sensor.t').plan;
  return addDevice(p, 'light.a', [2, 2]).plan;
}

const IDS: Record<Kind, string> = {
  wall: 'wall_1',
  room: 'room_1',
  door: 'door_1',
  window: 'window_1',
  source: 'sensor_1',
  device: 'device_1',
};

describe('KINDS', () => {
  it('finds and deletes every kind by id', () => {
    const p = plan();
    for (const [kind, id] of Object.entries(IDS) as [Kind, string][]) {
      expect(findItem(p, { kind, id })?.id).toBe(id);
      expect(findItem(kindOps(kind).remove(p, id), { kind, id })).toBeUndefined();
    }
    expect(findItem(p, { kind: 'door', id: 'window_1' })).toBeUndefined();
    expect(findItem(emptyPlan('x'), { kind: 'device', id: 'device_1' })).toBeUndefined();
  });

  it('drags walls and rooms on the grid, and sources and devices freely', () => {
    const p = plan();
    const drag = (kind: Kind, dx: number, dy: number): unknown => {
      const item = findItem(p, { kind, id: IDS[kind] })!;
      return findItem(kindOps(kind).drag(p, item, [dx, dy], [0, 0])!, { kind, id: IDS[kind] });
    };
    expect(drag('wall', 0.33, 0.01)).toMatchObject({ a: [0.35, 0], b: [4.35, 0] });
    expect(drag('room', 1.01, 0)).toMatchObject({
      polygon: [
        [1, 0],
        [5, 0],
        [5, 3],
      ],
    });
    expect(drag('source', 0.33, 0.01)).toMatchObject({ position: [1.33, 1.01] });
    expect(drag('device', -1, 0.5)).toMatchObject({ position: [1, 2.5] });
  });

  it('slides an opening along its wall to the pointer', () => {
    const p = plan();
    const door = findItem(p, { kind: 'door', id: 'door_1' })!;
    const moved = kindOps('door').drag(p, door, [0, 0], [2, 1])!;
    expect(moved.doors[0]!.offset).toBeCloseTo(1.6, 6);
    const orphan = { ...p, walls: [] };
    expect(kindOps('door').drag(orphan, door, [0, 0], [2, 1])).toBeUndefined();
  });

  it('titles each kind by its name for the inspector', () => {
    expect(Object.keys(KINDS).map(titleOf)).toEqual([
      'Wall',
      'Room',
      'Door',
      'Window',
      'Source',
      'Device',
    ]);
  });
});
