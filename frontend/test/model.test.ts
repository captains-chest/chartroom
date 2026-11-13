import { describe, expect, it } from 'vite-plus/test';
import { areaName, roomNameForAreas } from '../src/editor/rooms';
import { floorsKey, groupAreasByFloor } from '../src/model';
import type { Hass } from '../src/ha-types';

const hass: Hass = {
  floors: {
    upstairs: { floor_id: 'upstairs', name: 'Upstairs', level: 1 },
    ground: { floor_id: 'ground', name: 'Ground floor', level: 0 },
  },
  areas: {
    office: { area_id: 'office', name: 'Office', floor_id: 'upstairs' },
    kitchen: { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' },
    hall: { area_id: 'hall', name: 'Hall', floor_id: 'ground' },
    garden: { area_id: 'garden', name: 'Garden', floor_id: null },
    attic: { area_id: 'attic', name: 'Attic', floor_id: 'gone' },
  },
};

describe('groupAreasByFloor', () => {
  it('orders floors by level and areas by name, with unassigned areas last', () => {
    const groups = groupAreasByFloor(hass);
    expect(groups.map((g) => g.name)).toEqual(['Ground floor', 'Upstairs', 'No floor']);
    expect(groups[0]?.areas.map((a) => a.area_id)).toEqual(['hall', 'kitchen']);
    expect(groups[2]?.areas.map((a) => a.area_id)).toEqual(['attic', 'garden']);
  });

  it('handles a hass object without registries', () => {
    expect(groupAreasByFloor(undefined)).toEqual([]);
    expect(groupAreasByFloor({})).toEqual([]);
  });

  it('gives the same key for the same registries', () => {
    expect(floorsKey(groupAreasByFloor(hass))).toBe(floorsKey(groupAreasByFloor({ ...hass })));
  });
});

describe('roomNameForAreas', () => {
  it("takes the linked areas' names while the room has its default name", () => {
    expect(roomNameForAreas('Room 3', [], ['Kitchen'])).toBe('Kitchen');
    expect(roomNameForAreas('Room 3', [], ['Kitchen', 'Living room'])).toBe(
      'Kitchen & Living room',
    );
  });

  it('follows the areas while the name is still the one it took from them', () => {
    expect(roomNameForAreas('Kitchen', ['Kitchen'], ['Kitchen', 'Living room'])).toBe(
      'Kitchen & Living room',
    );
    expect(roomNameForAreas('Kitchen & Living room', ['Kitchen', 'Living room'], ['Kitchen'])).toBe(
      'Kitchen',
    );
  });

  it("keeps a name of the user's own, and any name when the last area goes", () => {
    expect(roomNameForAreas('Open plan', ['Kitchen'], ['Kitchen', 'Living room'])).toBe(
      'Open plan',
    );
    expect(roomNameForAreas('Kitchen', ['Kitchen'], [])).toBe('Kitchen');
    expect(roomNameForAreas('Room 3', [], [])).toBe('Room 3');
  });
});

describe('areaName', () => {
  it("names an area, or falls back to its id when it's gone", () => {
    expect(areaName(hass, 'kitchen')).toBe('Kitchen');
    expect(areaName(hass, 'pantry')).toBe('pantry');
    expect(areaName(undefined, 'pantry')).toBe('pantry');
  });
});
