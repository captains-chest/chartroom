import { describe, expect, it } from 'vite-plus/test';
import type { EntityState, Hass } from '../src/ha-types';
import { hassChanged, planInputs } from '../src/plan-inputs';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';

const st = (entity_id: string, state: string): EntityState => ({
  entity_id,
  state,
  attributes: {},
});

/** A plan reading one entity per layer that draws states. */
function plan(): Plan {
  const p = emptyPlan('Home');
  p.walls = [{ id: 'w', a: [0, 0], b: [4, 0], thickness: 0.1, material: 'brick' }];
  p.sources = [
    { id: 't', kind: 'sensor', entity_id: 'sensor.temp', position: [1, 1] },
    { id: 'ap', kind: 'access_point', entity_id: 'sensor.ap', position: [2, 1] },
  ];
  p.devices = [{ id: 'l', entity_id: 'light.lamp', position: [3, 1] }];
  p.doors = [
    {
      id: 'd',
      wall: 'w',
      offset: 0.5,
      width: 0.9,
      material: 'wood',
      thickness: 0.04,
      hinge: 'a',
      swing: 1,
      entity_id: 'binary_sensor.door',
    },
  ];
  p.windows = [
    {
      id: 'win',
      wall: 'w',
      offset: 2,
      width: 1,
      material: 'glass',
      thickness: 0.02,
      entity_id: 'binary_sensor.win',
    },
  ];
  return p;
}

const IDS = ['sensor.temp', 'sensor.ap', 'light.lamp', 'binary_sensor.door', 'binary_sensor.win'];

function hass(): Hass {
  return {
    states: Object.fromEntries(
      [...IDS, 'light.elsewhere'].map((id) => [id, st(id, 'on')] as const),
    ),
    entities: {},
    devices: {},
    areas: {},
    floors: {},
  };
}

/** `h` with one entity's state replaced, as Home Assistant does on a state change. */
const withState = (h: Hass, id: string, state: string): Hass => ({
  ...h,
  states: { ...h.states, [id]: st(id, state) },
});

describe('plan inputs', () => {
  it('lists every entity a layer reads: sensors, signal sources, devices, doors and windows', () => {
    expect([...planInputs(plan())].sort()).toEqual([...IDS].sort());
    expect(planInputs(null)).toEqual([]);
  });

  it('works the list out once per plan object', () => {
    const p = plan();
    expect(planInputs(p)).toBe(planInputs(p));
    expect(planInputs({ ...p })).not.toBe(planInputs(p));
  });

  it('ignores a state change of an entity the plan does not read', () => {
    const h = hass();
    expect(hassChanged(h, withState(h, 'light.elsewhere', 'off'), planInputs(plan()))).toBe(false);
    expect(hassChanged(h, h, [])).toBe(false);
    expect(hassChanged(h, { ...h }, IDS)).toBe(false);
  });

  it.each(IDS)('passes a state change of %s', (id) => {
    const h = hass();
    expect(hassChanged(h, withState(h, id, 'off'), planInputs(plan()))).toBe(true);
  });

  it.each(['entities', 'devices', 'areas', 'floors', 'connection', 'user'] as const)(
    'passes a new %s, whatever the states',
    (k) => {
      const h = hass();
      expect(hassChanged(h, { ...h, [k]: {} }, [])).toBe(true);
    },
  );

  it('passes the first hass and its loss', () => {
    expect(hassChanged(undefined, hass(), [])).toBe(true);
    expect(hassChanged(hass(), undefined, [])).toBe(true);
  });

  it('passes an entity that appears or goes away', () => {
    const h = hass();
    const gone = { ...h, states: { ...h.states } };
    delete gone.states['sensor.temp'];
    expect(hassChanged(h, gone, IDS)).toBe(true);
    expect(hassChanged(gone, h, IDS)).toBe(true);
  });
});
