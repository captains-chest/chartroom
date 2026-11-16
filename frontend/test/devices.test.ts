import { describe, expect, it } from 'vite-plus/test';
import { pointInPolygon } from '../src/geometry';
import type { EntityState, Hass } from '../src/ha-types';
import { autoPlace, deviceChoices, deviceLook, spotsInRoom, tapAction } from '../src/devices';
import { LIMITS } from '../src/plan/constants';
import { emptyPlan, limitWarnings, validatePlan } from '../src/plan/functions';
import { normalizePlan } from '../src/plan/schema';
import type { Plan } from '../src/plan/models';
import { addDevice, deleteDevice, moveDevice, scalePlan, updateDevice } from '../src/plan/ops';

const st = (
  entity_id: string,
  state: string,
  device_class?: string,
  name?: string,
): EntityState => ({
  entity_id,
  state,
  attributes: { friendly_name: name ?? entity_id, ...(device_class ? { device_class } : {}) },
});

describe('deviceLook', () => {
  it.each([
    ['light.a', 'on', undefined, 'on', true, 'light'],
    ['light.a', 'off', undefined, 'off', false, 'light'],
    ['switch.a', 'on', 'outlet', 'on', true, 'plug'],
    ['switch.a', 'off', undefined, 'off', false, 'switch'],
    ['fan.a', 'on', undefined, 'on', true, 'fan'],
    ['input_boolean.a', 'off', undefined, 'off', false, 'toggle'],
    ['binary_sensor.d', 'on', 'door', 'open', true, 'door'],
    ['binary_sensor.d', 'off', 'door', 'closed', false, 'door'],
    ['binary_sensor.w', 'on', 'window', 'open', true, 'window'],
    ['binary_sensor.g', 'off', 'garage_door', 'closed', false, 'garage'],
    ['binary_sensor.m', 'on', 'motion', 'on', true, 'motion'],
    ['binary_sensor.l', 'on', 'lock', 'unlocked', true, 'lock'],
    ['binary_sensor.x', 'on', 'moisture', 'on', true, 'sensor'],
    ['cover.c', 'open', 'blind', 'open', true, 'cover'],
    ['cover.c', 'closed', 'garage', 'closed', false, 'garage'],
    ['cover.c', 'opening', undefined, 'opening', true, 'cover'],
    ['lock.l', 'locked', undefined, 'locked', false, 'lock'],
    ['lock.l', 'unlocked', undefined, 'unlocked', true, 'lock'],
    ['light.a', 'unavailable', undefined, 'unavailable', false, 'light'],
    ['switch.a', 'unknown', undefined, 'unknown', false, 'switch'],
  ] as const)('%s %s (%s) is %s', (id, state, cls, status, active, glyph) => {
    const look = deviceLook(id, st(id, state, cls));
    expect(look).toMatchObject({ status, active, glyph });
  });

  it('labels with the friendly name and plain words', () => {
    expect(
      deviceLook('binary_sensor.m', st('binary_sensor.m', 'on', 'motion', 'Hall motion')).label,
    ).toBe('Hall motion: detected');
    expect(
      deviceLook('binary_sensor.d', st('binary_sensor.d', 'off', 'door', 'Front door')).label,
    ).toBe('Front door: closed');
    expect(deviceLook('lock.l', st('lock.l', 'jammed', undefined, 'Gate')).label).toBe(
      'Gate: jammed',
    );
  });

  it('treats a missing entity as unavailable', () => {
    expect(deviceLook('light.gone', undefined)).toMatchObject({
      status: 'unavailable',
      label: 'light.gone: unavailable',
    });
  });
});

describe('tapAction', () => {
  it.each(['light.a', 'switch.a', 'fan.a', 'input_boolean.a'])('%s toggles', (id) => {
    expect(tapAction(id, st(id, 'off'))).toEqual({
      type: 'service',
      domain: id.split('.')[0],
      service: 'toggle',
    });
  });

  it('opens a closed cover, closes an open one and stops a moving one', () => {
    expect(tapAction('cover.c', st('cover.c', 'closed'))).toMatchObject({ service: 'open_cover' });
    expect(tapAction('cover.c', st('cover.c', 'open'))).toMatchObject({ service: 'close_cover' });
    expect(tapAction('cover.c', st('cover.c', 'closing'))).toMatchObject({ service: 'stop_cover' });
  });

  it('asks before locking or unlocking', () => {
    expect(tapAction('lock.f', st('lock.f', 'locked', undefined, 'Front door'))).toEqual({
      type: 'service',
      domain: 'lock',
      service: 'unlock',
      confirm: 'Unlock Front door?',
    });
    expect(tapAction('lock.f', st('lock.f', 'unlocked'))).toMatchObject({
      service: 'lock',
      confirm: 'Lock lock.f?',
    });
    expect(tapAction('lock.f', st('lock.f', 'jammed'))).toEqual({ type: 'more-info' });
  });

  it('shows details for sensors and for anything unavailable', () => {
    expect(tapAction('binary_sensor.d', st('binary_sensor.d', 'on', 'door'))).toEqual({
      type: 'more-info',
    });
    expect(tapAction('light.a', st('light.a', 'unavailable'))).toEqual({ type: 'more-info' });
    expect(tapAction('light.a', undefined)).toEqual({ type: 'more-info' });
  });
});

const hass: Hass = {
  floors: { ground: { floor_id: 'ground', name: 'Ground', level: 0 } },
  areas: {
    kitchen: { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' },
    hall: { area_id: 'hall', name: 'Hall', floor_id: 'ground' },
    attic: { area_id: 'attic', name: 'Attic', floor_id: null },
  },
  entities: {
    'light.kitchen': { entity_id: 'light.kitchen', area_id: 'kitchen' },
    'switch.kettle': { entity_id: 'switch.kettle', device_id: 'dev1' },
    'binary_sensor.front_door': { entity_id: 'binary_sensor.front_door', area_id: 'hall' },
    'light.attic': { entity_id: 'light.attic', area_id: 'attic' },
    'switch.kitchen_identify': {
      entity_id: 'switch.kitchen_identify',
      area_id: 'kitchen',
      entity_category: 'config',
    },
    'light.hidden': { entity_id: 'light.hidden', area_id: 'kitchen', hidden: true },
  },
  devices: { dev1: { id: 'dev1', area_id: 'kitchen' } },
  states: Object.fromEntries(
    [
      st('light.kitchen', 'on', undefined, 'Kitchen light'),
      st('switch.kettle', 'off', undefined, 'Kettle'),
      st('binary_sensor.front_door', 'off', 'door', 'Front door'),
      st('light.attic', 'off', undefined, 'Attic light'),
      st('switch.kitchen_identify', 'off'),
      st('light.hidden', 'off'),
      st('sensor.kitchen_temperature', '21', 'temperature'),
    ].map((x) => [x.entity_id, x]),
  ),
};

describe('deviceChoices', () => {
  it('offers device domains on the floor, by name, skipping hidden and config entities', () => {
    expect(deviceChoices(hass, 'ground')).toEqual([
      { entity_id: 'binary_sensor.front_door', name: 'Front door', area_id: 'hall' },
      { entity_id: 'switch.kettle', name: 'Kettle', area_id: 'kitchen' },
      { entity_id: 'light.kitchen', name: 'Kitchen light', area_id: 'kitchen' },
    ]);
  });

  it('offers every floor on a plan without one', () => {
    expect(deviceChoices(hass, null).map((c) => c.entity_id)).toContain('light.attic');
  });
});

const square = (x: number, y: number, w: number): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + w],
  [x, y + w],
];

function roomsPlan(): Plan {
  return {
    ...emptyPlan('Test', 'ground'),
    rooms: [
      { id: 'kitchen', name: 'Kitchen', polygon: square(0, 0, 3), area_ids: ['kitchen'] },
      { id: 'hall', name: 'Hall', polygon: square(3, 0, 2), area_ids: ['hall'] },
      { id: 'store', name: 'Store', polygon: square(5, 0, 1) },
    ],
  };
}

describe('autoPlace', () => {
  it('puts each device inside the room of its area, apart from each other', () => {
    const plan = roomsPlan();
    const spots = autoPlace(plan, deviceChoices(hass, 'ground'));
    expect(spots.map((s) => s.entity_id).sort()).toEqual([
      'binary_sensor.front_door',
      'light.kitchen',
      'switch.kettle',
    ]);
    for (const s of spots) {
      const area = hass.entities![s.entity_id]!.area_id ?? 'kitchen';
      const room = plan.rooms.find((r) => r.area_ids?.includes(area))!;
      expect(pointInPolygon(s.position, room.polygon)).toBe(true);
    }
    const [a, b] = spots.filter((s) => s.entity_id !== 'binary_sensor.front_door');
    expect(
      Math.hypot(a!.position[0] - b!.position[0], a!.position[1] - b!.position[1]),
    ).toBeGreaterThan(0.3);
  });

  it('puts the devices of every area a room links into that room', () => {
    // One open-plan room for the kitchen and the hall.
    const plan: Plan = {
      ...emptyPlan('Open plan', 'ground'),
      rooms: [
        { id: 'open', name: 'Open', polygon: square(0, 0, 5), area_ids: ['kitchen', 'hall'] },
      ],
    };
    const spots = autoPlace(plan, deviceChoices(hass, 'ground'));
    expect(spots.map((s) => s.entity_id).sort()).toEqual([
      'binary_sensor.front_door',
      'light.kitchen',
      'switch.kettle',
    ]);
    for (const s of spots) expect(pointInPolygon(s.position, plan.rooms[0]!.polygon)).toBe(true);
    // Apart from each other, across both areas.
    for (const [i, a] of spots.entries())
      for (const b of spots.slice(i + 1))
        expect(
          Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]),
        ).toBeGreaterThan(0.3);
  });

  it('places by the area a plan saved before multi-area rooms stored', () => {
    const plan = normalizePlan({
      ...emptyPlan('Old', 'ground'),
      rooms: [{ id: 'kitchen', name: 'Kitchen', polygon: square(0, 0, 3), area_id: 'kitchen' }],
    });
    expect(
      autoPlace(plan, deviceChoices(hass, 'ground'))
        .map((s) => s.entity_id)
        .sort(),
    ).toEqual(['light.kitchen', 'switch.kettle']);
  });

  it('skips devices already on the plan and areas without a room', () => {
    const plan = addDevice(roomsPlan(), 'light.kitchen', [1, 1]).plan;
    const spots = autoPlace(plan, deviceChoices(hass, null));
    expect(spots.map((s) => s.entity_id)).not.toContain('light.kitchen');
    expect(spots.map((s) => s.entity_id)).not.toContain('light.attic');
  });

  it('keeps off the room name and area label', () => {
    const spots = spotsInRoom(square(0, 0, 4), 6, [], [2, 2]);
    for (const p of spots) expect(Math.abs(p[0] - 2) < 1.4 && Math.abs(p[1] - 2) < 0.6).toBe(false);
    expect(spots[0]).toEqual([2, 3.1]);
  });

  it('keeps spots clear of what is already there', () => {
    const spots = spotsInRoom(square(0, 0, 3), 5, [[1.5, 1.5]]);
    expect(spots).toHaveLength(5);
    for (const p of spots) expect(Math.hypot(p[0] - 1.5, p[1] - 1.5)).toBeGreaterThan(0.3);
  });
});

describe('device ops', () => {
  it('adds, moves, re-points and deletes a device', () => {
    let r = addDevice(emptyPlan('x'), 'light.a', [1.23456, 2]);
    expect(r.id).toBe('device_1');
    expect(r.plan.devices).toEqual([
      { id: 'device_1', entity_id: 'light.a', position: [1.235, 2] },
    ]);
    const again = addDevice(r.plan, 'light.a', [3, 3]);
    expect(again.id).toBe('device_1');
    expect(again.plan.devices).toHaveLength(1);
    expect(again.plan.devices![0]!.position).toEqual([3, 3]);
    r = addDevice(again.plan, 'switch.b', [0, 0]);
    expect(r.id).toBe('device_2');
    let p = moveDevice(r.plan, 'device_2', [0.5, 0.5]);
    p = updateDevice(p, 'device_2', 'switch.c');
    expect(p.devices![1]).toEqual({ id: 'device_2', entity_id: 'switch.c', position: [0.5, 0.5] });
    expect(validatePlan(p)).toEqual([]);
    expect(deleteDevice(p, 'device_1').devices!.map((d) => d.id)).toEqual(['device_2']);
  });

  it('scales with the plan', () => {
    const p = addDevice(emptyPlan('x'), 'light.a', [1, 2]).plan;
    expect(scalePlan(p, 2).devices![0]!.position).toEqual([2, 4]);
  });

  it('normalizes old plans to no devices and validates entity ids', () => {
    const { devices: _d, ...old } = emptyPlan('old');
    expect(normalizePlan(old).devices).toEqual([]);
    const bad: Plan = {
      ...emptyPlan('bad'),
      devices: [
        { id: 'device_1', entity_id: 'light.a', position: [0, 0] },
        { id: 'device_2', entity_id: 'light.a', position: [1, 0] },
        { id: 'device_3', entity_id: 'nope', position: [1, 0] },
      ],
    };
    expect(validatePlan(bad)).toEqual([
      'device device_2: light.a is placed twice',
      'device device_3: bad entity_id nope',
    ]);
  });

  it('warns above the device limit', () => {
    const devices = Array.from({ length: LIMITS.devices + 1 }, (_, i) => ({
      id: `device_${i}`,
      entity_id: `light.l${i}`,
      position: [0, 0] as [number, number],
    }));
    expect(limitWarnings({ ...emptyPlan('x'), devices })).toHaveLength(1);
  });
});
