import { describe, expect, it } from 'vite-plus/test';
import type { EntityState, Hass } from '../src/ha-types';
import { LAYERS, STALE_MS } from '../src/heat/constants';
import {
  easeOut,
  isHeatLayer,
  layerCounts,
  layerData,
  layerDomain,
  layerOfState,
  layoutKey,
  rampLut,
  staleAt,
} from '../src/heat/functions';
import { emptyPlan } from '../src/plan/functions';
import type { Device, Plan } from '../src/plan/models';

const NOW = Date.parse('2026-10-24T08:00:00Z');

const st = (
  entity_id: string,
  state: string,
  device_class: string | undefined,
  unit: string,
  last_reported = '2026-10-24T07:59:00Z',
): EntityState => ({
  entity_id,
  state,
  attributes: { device_class, unit_of_measurement: unit },
  last_reported,
});

const src = (id: string, entity_id: string, x: number, y: number): Device => ({
  id,
  entity_id,
  position: [x, y],
});

function setup(): { plan: Plan; hass: Hass } {
  const plan = emptyPlan('Test');
  plan.devices = [
    src('a', 'sensor.a_temp', 0, 0),
    src('b', 'sensor.b_temp', 4, 0),
    src('c', 'sensor.c_temp_f', 2, 3),
    src('d', 'sensor.dead', 1, 1),
    src('e', 'sensor.old', 3, 1),
    src('f', 'sensor.junk', 2, 2),
    src('h', 'sensor.hum', 1, 2),
    src('p', 'sensor.power', 3, 3),
  ];
  plan.sources = [{ id: 'r', kind: 'radio', entity_id: 'sensor.a_temp', position: [0, 3] }];
  const states: Record<string, EntityState> = {
    'sensor.a_temp': st('sensor.a_temp', '25', 'temperature', '°C'),
    'sensor.b_temp': st('sensor.b_temp', '30', 'temperature', '°C'),
    'sensor.c_temp_f': st('sensor.c_temp_f', '77', 'temperature', '°F'),
    'sensor.dead': st('sensor.dead', 'unavailable', 'temperature', '°C'),
    'sensor.old': st('sensor.old', '20', 'temperature', '°C', '2026-10-23T08:00:00Z'),
    'sensor.junk': st('sensor.junk', 'abc', undefined, '°C'),
    'sensor.hum': st('sensor.hum', '55', 'humidity', '%'),
    'sensor.power': st('sensor.power', '120', 'power', 'W'),
  };
  return { plan, hass: { states } as Hass };
}

describe('heat layers', () => {
  it('assigns sensors to layers by device class, else by unit', () => {
    expect(layerOfState(st('x', '1', 'temperature', '°C'))).toBe('temperature');
    expect(layerOfState(st('x', '1', 'humidity', '%'))).toBe('humidity');
    expect(layerOfState(st('x', '1', undefined, '°F'))).toBe('temperature');
    expect(layerOfState(st('x', '1', 'power', 'W'))).toBeNull();
    expect(layerOfState(st('x', '1', undefined, '%'))).toBeNull();
  });

  it('keeps numeric, fresh readings in one unit and leaves out the rest with a reason', () => {
    const { plan, hass } = setup();
    const t = layerData(plan, hass, 'temperature', NOW);
    expect(t.unit).toBe('°C');
    expect(t.readings.map((r) => [r.id, r.value])).toEqual([
      ['a', 25],
      ['b', 30],
      ['c', 25], // 77 °F
    ]);
    expect(Object.fromEntries(t.excluded.map((e) => [e.id, e.reason]))).toEqual({
      d: 'unavailable',
      e: 'stale',
      f: 'not a number',
    });
    expect(t.excluded.find((e) => e.id === 'd')?.position).toEqual([1, 1]);
    const h = layerData(plan, hass, 'humidity', NOW);
    expect(h.readings.map((r) => r.value)).toEqual([55]);
    expect(h.unit).toBe('%');
  });

  it('reads both layers from one device item, at its position', () => {
    const plan = {
      ...emptyPlan('Test'),
      devices: [{ ...src('m', 'sensor.m_temp', 2, 1), device_id: 'm' }],
    };
    const hass = {
      states: {
        'sensor.m_temp': st('sensor.m_temp', '21', 'temperature', '°C'),
        'sensor.m_hum': st('sensor.m_hum', '48', 'humidity', '%'),
      },
      entities: {
        'sensor.m_temp': { entity_id: 'sensor.m_temp', device_id: 'm' },
        'sensor.m_hum': { entity_id: 'sensor.m_hum', device_id: 'm' },
      },
    } as Hass;
    const read = (layer: 'temperature' | 'humidity'): unknown[] =>
      layerData(plan, hass, layer, NOW).readings.map((r) => [
        r.id,
        r.entity_id,
        r.position,
        r.value,
      ]);
    expect(read('temperature')).toEqual([['m', 'sensor.m_temp', [2, 1], 21]]);
    expect(read('humidity')).toEqual([['m', 'sensor.m_hum', [2, 1], 48]]);
    expect(layerCounts(plan, hass)).toEqual({ temperature: 1, humidity: 1, signal: 0 });
  });

  it('treats a reading as stale only past STALE_MS', () => {
    const { plan, hass } = setup();
    const at = Date.parse('2026-10-23T08:00:00Z');
    expect(layerData(plan, hass, 'temperature', at + STALE_MS - 1).excluded).toHaveLength(2);
    expect(layerData(plan, hass, 'temperature', at + STALE_MS + 1).excluded).toHaveLength(3);
  });

  it('says when the first fresh reading goes stale, so the layer can look again then', () => {
    const { plan, hass } = setup();
    const data = layerData(plan, hass, 'temperature', NOW);
    // a, b and c were reported at 07:59; old is stale already and is not a reading.
    expect(staleAt(data, hass, NOW)).toBe(Date.parse('2026-10-24T07:59:00Z') + STALE_MS);
    expect(staleAt(layerData(plan, hass, 'signal', NOW), hass, NOW)).toBe(Infinity);
    const noStamps = {
      states: { 'sensor.a_temp': { ...hass.states!['sensor.a_temp']!, last_reported: undefined } },
    } as Hass;
    expect(staleAt(layerData(plan, noStamps, 'temperature', NOW), noStamps, NOW)).toBe(Infinity);
  });

  it('falls back to the default unit with no plan or no readings', () => {
    expect(layerData(null, undefined, 'temperature')).toMatchObject({ unit: '°C', readings: [] });
    expect(layerData(null, undefined, 'humidity')).toMatchObject({ unit: '%', readings: [] });
  });

  it('counts placed sensors per layer whatever their state', () => {
    const { plan, hass } = setup();
    expect(layerCounts(plan, hass)).toEqual({ temperature: 6, humidity: 1, signal: 1 });
    expect(layerCounts(null, hass)).toEqual({ temperature: 0, humidity: 0, signal: 0 });
  });

  it('widens the default domain to whole numbers around the data', () => {
    expect(layerDomain('temperature', '°C', [21, 22])).toEqual([16, 28]);
    expect(layerDomain('temperature', '°C', [14.2, 31.4])).toEqual([14, 32]);
    expect(layerDomain('temperature', '°F', [])).toEqual([61, 82]);
    expect(layerDomain('humidity', 'weird', [80.5])).toEqual([30, 81]);
  });

  it('builds a 256-entry ramp through every stop', () => {
    for (const id of ['temperature', 'humidity'] as const) {
      const stops = LAYERS[id].ramp;
      const lut = rampLut(stops);
      expect(lut).toHaveLength(1024);
      for (const [t, r, g, b] of stops) {
        const i = Math.round(t * 255);
        // Within a level or two: the stop sits between two LUT entries.
        expect(Math.abs(lut[i * 4]! - r)).toBeLessThanOrEqual(2);
        expect(Math.abs(lut[i * 4 + 1]! - g)).toBeLessThanOrEqual(2);
        expect(Math.abs(lut[i * 4 + 2]! - b)).toBeLessThanOrEqual(2);
        expect(lut[i * 4 + 3]).toBe(255);
      }
    }
    // Temperature runs from blue to red.
    const lut = rampLut(LAYERS.temperature.ramp);
    expect(lut[2]! > lut[0]!).toBe(true);
    expect(lut[255 * 4]! > lut[255 * 4 + 2]!).toBe(true);
  });

  it('eases out and keys layouts by sensor positions only', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeCloseTo(0.875);
    const { plan, hass } = setup();
    const a = layerData(plan, hass, 'temperature', NOW).readings;
    const b = a.map((r) => ({ ...r, value: r.value + 1 }));
    expect(layoutKey(a, plan.outline)).toBe(layoutKey(b, plan.outline));
    const moved = a.map((r, i) => (i === 0 ? { ...r, position: [0.5, 0] as [number, number] } : r));
    expect(layoutKey(moved, plan.outline)).not.toBe(layoutKey(a, plan.outline));
    expect(isHeatLayer('humidity')).toBe(true);
    expect(isHeatLayer('none')).toBe(false);
  });
});
