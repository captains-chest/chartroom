import { describe, expect, it } from 'vite-plus/test';
import { floorTabs, planIdForFloor, areaChoices } from '../src/model';
import { fitView, MIN_WIDTH, panBy, toPlan, viewBoxOf, withAspect, zoomAt } from '../src/viewport';

describe('viewport', () => {
  it('fits bounds at the element aspect with a margin', () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, 2, 1);
    expect(v).toEqual({ x: -1, y: -1, w: 12, h: 6 });
    expect(fitView({ minX: 0, minY: 0, maxX: 2, maxY: 10 }, 1, 0)).toEqual({
      x: -4,
      y: 0,
      w: 10,
      h: 10,
    });
  });

  it('zooms about the cursor, within limits', () => {
    const v = { x: 0, y: 0, w: 10, h: 5 };
    const z = zoomAt(v, [8, 4], 2);
    expect(z).toEqual({ x: 4, y: 2, w: 5, h: 2.5 });
    // The point under the cursor stays put.
    expect(toPlan(z, 800 * 0.8, 400 * 0.8, 800, 400)).toEqual([8, 4]);
    expect(zoomAt(v, [0, 0], 1000).w).toBe(MIN_WIDTH);
  });

  it('pans, re-aspects and prints a viewBox', () => {
    expect(panBy({ x: 0, y: 0, w: 4, h: 2 }, 1, -1)).toEqual({ x: 1, y: -1, w: 4, h: 2 });
    expect(withAspect({ x: 0, y: 0, w: 4, h: 2 }, 1)).toEqual({ x: 0, y: -1, w: 4, h: 4 });
    expect(viewBoxOf({ x: 1 / 3, y: 0, w: 2, h: 1 })).toBe('0.333 0 2 1');
  });
});

describe('floorTabs', () => {
  const hass = {
    floors: {
      first: { floor_id: 'first', name: 'First floor', level: 1 },
      ground: { floor_id: 'ground', name: 'Ground floor', level: 0 },
    },
    areas: {
      kitchen: { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' },
      bath: { area_id: 'bath', name: 'Bath', floor_id: 'first' },
      attic: { area_id: 'attic', name: 'Attic', floor_id: null },
    },
  };

  it('lists floors by level with their plans, then plans without a known floor', () => {
    const tabs = floorTabs(hass, [
      { id: 'example', name: 'Example', floor_id: null },
      { id: 'floor_ground', name: 'Ground', floor_id: 'ground' },
      { id: 'old', name: 'Old', floor_id: 'demolished' },
    ]);
    expect(tabs).toEqual([
      { key: 'floor:ground', label: 'Ground floor', floor_id: 'ground', plan_id: 'floor_ground' },
      { key: 'floor:first', label: 'First floor', floor_id: 'first', plan_id: null },
      { key: 'plan:example', label: 'Example', floor_id: null, plan_id: 'example' },
      { key: 'plan:old', label: 'Old', floor_id: null, plan_id: 'old' },
    ]);
    expect(floorTabs(undefined, [])).toEqual([]);
  });

  it('makes storage-safe plan ids and orders area choices by floor', () => {
    expect(planIdForFloor('Ground Floor!')).toBe('floor_ground_floor_');
    expect(areaChoices(hass, 'first').map((a) => a.area_id)).toEqual(['bath', 'attic', 'kitchen']);
  });
});
