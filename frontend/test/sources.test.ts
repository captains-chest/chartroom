import { describe, expect, it } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { entityArea, sourceChoices } from '../src/model';
import { LIMITS } from '../src/plan/constants';
import { emptyPlan, limitWarnings, validatePlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { MAX_SIGNAL_SOURCES } from '../src/signal';
import {
  addSource,
  addWall,
  deleteSource,
  moveSource,
  scalePlan,
  updateSource,
} from '../src/plan/ops';

const sensor = (entity_id: string, device_class: string, name: string) => ({
  entity_id,
  state: '21',
  attributes: { device_class, friendly_name: name },
});

const hass: Hass = {
  floors: {
    ground: { floor_id: 'ground', name: 'Ground floor', level: 0 },
    upstairs: { floor_id: 'upstairs', name: 'Upstairs', level: 1 },
  },
  areas: {
    kitchen: { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' },
    office: { area_id: 'office', name: 'Office', floor_id: 'upstairs' },
  },
  devices: { dev1: { id: 'dev1', area_id: 'kitchen' } },
  entities: {
    'sensor.kitchen_temperature': { entity_id: 'sensor.kitchen_temperature', area_id: 'kitchen' },
    'sensor.kitchen_humidity': { entity_id: 'sensor.kitchen_humidity', device_id: 'dev1' },
    'sensor.office_temperature': { entity_id: 'sensor.office_temperature', area_id: 'office' },
    'sensor.kitchen_power': { entity_id: 'sensor.kitchen_power', area_id: 'kitchen' },
    'device_tracker.ap': { entity_id: 'device_tracker.ap', area_id: 'kitchen' },
  },
  states: {
    'sensor.kitchen_temperature': sensor(
      'sensor.kitchen_temperature',
      'temperature',
      'Kitchen temperature',
    ),
    'sensor.kitchen_humidity': sensor('sensor.kitchen_humidity', 'humidity', 'Kitchen humidity'),
    'sensor.office_temperature': sensor(
      'sensor.office_temperature',
      'temperature',
      'Office temperature',
    ),
    'sensor.kitchen_power': sensor('sensor.kitchen_power', 'power', 'Kitchen power'),
    'sensor.loose_temperature': sensor(
      'sensor.loose_temperature',
      'temperature',
      'Loose temperature',
    ),
    'device_tracker.ap': { entity_id: 'device_tracker.ap', state: 'home', attributes: {} },
  },
};

describe('entityArea', () => {
  it('uses the entity area, else the device area', () => {
    expect(entityArea(hass, 'sensor.kitchen_temperature')).toBe('kitchen');
    expect(entityArea(hass, 'sensor.kitchen_humidity')).toBe('kitchen');
    expect(entityArea(hass, 'sensor.loose_temperature')).toBeNull();
    expect(entityArea(undefined, 'sensor.x')).toBeNull();
  });
});

describe('sourceChoices', () => {
  it('offers any entity on the floor for access points and radios', () => {
    const ids = sourceChoices(hass, 'ground').map((c) => c.entity_id);
    expect(ids).toContain('device_tracker.ap');
    expect(ids).toContain('sensor.kitchen_power');
    expect(ids).not.toContain('sensor.office_temperature');
    expect(sourceChoices(hass, null)).toHaveLength(6);
  });
});

describe('source operations', () => {
  it('adds, moves, updates and deletes sources immutably', () => {
    const base = emptyPlan('Test');
    const a = addSource(base, 'radio', [1.23456, 2], 'sensor.zigbee_rssi', 'kitchen');
    expect(base.sources).toHaveLength(0);
    expect(a.id).toBe('radio_1');
    expect(a.plan.sources[0]).toEqual({
      id: 'radio_1',
      kind: 'radio',
      entity_id: 'sensor.zigbee_rssi',
      position: [1.235, 2],
      area_id: 'kitchen',
      tx_dbm: -45,
    });
    const b = addSource(a.plan, 'access_point', [3, 3]);
    expect(b.id).toBe('access_point_1');
    expect(b.plan.sources[1]?.tx_dbm).toBe(-40);
    const moved = moveSource(b.plan, 'radio_1', [4, 5]);
    expect(moved.sources[0]?.position).toEqual([4, 5]);
    const changed = updateSource(moved, 'access_point_1', { kind: 'radio', area_id: null });
    expect(changed.sources[1]?.kind).toBe('radio');
    expect(changed.sources[1]).not.toHaveProperty('area_id');
    const gone = deleteSource(changed, 'radio_1');
    expect(gone.sources.map((s) => s.id)).toEqual(['access_point_1']);
    expect(validatePlan(gone)).toEqual([]);
  });

  it('scales source positions with the plan', () => {
    const p = addSource(emptyPlan('Test'), 'radio', [2, 4]).plan;
    expect(scalePlan(p, 0.5).sources[0]?.position).toEqual([1, 2]);
  });
});

describe('limitWarnings', () => {
  it('warns above the soft wall and access point limits', () => {
    let plan: Plan = emptyPlan('Big');
    expect(limitWarnings(plan)).toEqual([]);
    for (let i = 0; i <= LIMITS.walls; i++) plan = addWall(plan, [i, 0], [i, 1]).plan;
    for (let i = 0; i < LIMITS.accessPoints; i++)
      plan = addSource(plan, 'access_point', [i, 2]).plan;
    const w = limitWarnings(plan);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/513 walls/);
    plan = addSource(plan, 'radio', [0, 4]).plan;
    expect(limitWarnings(plan)[1]).toMatch(
      /33 access points and radios .*uses the first 32 and leaves out the rest/,
    );
  });

  it("warns at the signal map's own source limit", () => {
    expect(LIMITS.accessPoints).toBe(MAX_SIGNAL_SOURCES);
  });
});
