import { describe, expect, it } from 'vite-plus/test';
import {
  areaChoices,
  floorTabs,
  HOME_PLAN_ID,
  HOME_TAB,
  newPlanId,
  planIdForFloor,
} from '../src/model';
import { fitView, MIN_WIDTH, panBy, toPlan, viewBoxOf, withAspect, zoomAt } from '../src/viewport';

describe('viewport', () => {
  it('fits bounds at the element aspect with a margin', () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, 2, 1, 1);
    expect(v).toEqual({ x: -1, y: -1, w: 12, h: 6 });
    expect(fitView({ minX: 0, minY: 0, maxX: 2, maxY: 10 }, 1, 1, 0)).toEqual({
      x: -4,
      y: 0,
      w: 10,
      h: 10,
    });
  });

  it('fits clear of a legend in a corner', () => {
    // A 10×4 m plan in 400×200 px with a 100×80 px legend at the top right: beside it the plan
    // fits 300×200 px, below it 400×120 px; beside it is larger.
    const legend = { left: 290, top: 10, right: 390, bottom: 90 };
    const v = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, 400, 200, 0, [legend]);
    const px = (x: number, y: number) => [((x - v.x) / v.w) * 400, ((y - v.y) / v.h) * 200];
    const [right] = px(10, 0);
    expect(right).toBeCloseTo(290);
    expect(px(0, 4)[0]).toBeCloseTo(0);
  });

  it('fits clear of several covers', () => {
    // The same plan and legend, and buttons across the top 30 px: below the buttons and beside the
    // legend leaves 290×170 px, where the plan shows 290×116 px, centred.
    const legend = { left: 290, top: 10, right: 390, bottom: 90 };
    const buttons = { left: 10, top: 10, right: 390, bottom: 30 };
    const v = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, 400, 200, 0, [legend, buttons]);
    const px = (x: number, y: number) => [((x - v.x) / v.w) * 400, ((y - v.y) / v.h) * 200];
    expect(px(0, 0)[0]).toBeCloseTo(0);
    expect(px(10, 4)[0]).toBeCloseTo(290);
    expect(px(0, 0)[1]).toBeCloseTo(57);
    expect(px(10, 4)[1]).toBeCloseTo(173);
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

  it('offers the home tab when Home Assistant has no floors and there are no plans', () => {
    const noFloors = { floors: {}, areas: hass.areas };
    expect(floorTabs(noFloors, [])).toEqual([HOME_TAB]);
    expect(HOME_TAB).toEqual({ key: 'plan:home', label: 'Home', floor_id: null, plan_id: null });
    // The home plan, once saved, keeps the same tab key so the panel stays on it.
    expect(floorTabs(noFloors, [{ id: HOME_PLAN_ID, name: 'Home', floor_id: null }])).toEqual([
      { key: 'plan:home', label: 'Home', floor_id: null, plan_id: 'home' },
    ]);
    // Any other plan, or a floor, replaces it.
    expect(floorTabs(noFloors, [{ id: 'example', name: 'Example', floor_id: null }])).toEqual([
      { key: 'plan:example', label: 'Example', floor_id: null, plan_id: 'example' },
    ]);
    expect(floorTabs(hass, []).map((t) => t.key)).toEqual(['floor:ground', 'floor:first']);
    // Not before the floor registry has loaded.
    expect(floorTabs({ areas: hass.areas }, [])).toEqual([]);
  });

  it('names a new plan after its floor, or the home plan without one', () => {
    expect(
      newPlanId({ key: 'floor:Ground', label: 'Ground', floor_id: 'Ground', plan_id: null }),
    ).toBe('floor_ground');
    expect(newPlanId(HOME_TAB)).toBe(HOME_PLAN_ID);
  });

  it('makes storage-safe plan ids and orders area choices by floor', () => {
    expect(planIdForFloor('Ground Floor!')).toBe('floor_ground_floor_');
    expect(areaChoices(hass, 'first').map((a) => a.area_id)).toEqual(['bath', 'attic', 'kitchen']);
  });
});
