import { describe, expect, it } from 'vite-plus/test';
import type { Hass, HassConnection } from '../src/ha-types';
import { layerData } from '../src/heat';
import { emptyPlan, type Plan } from '../src/plan';
import { fetchTimeline, hassAt, planEntities, statesAt, type Timeline } from '../src/time-bar';
import { squeeze } from '../../scripts/minify-literals';

function plan(): Plan {
  const p = emptyPlan('History');
  p.sources = [
    { id: 't', kind: 'sensor', entity_id: 'sensor.t', position: [1, 1] },
    { id: 'u', kind: 'sensor', entity_id: 'sensor.u', position: [2, 1] },
    { id: 'ap', kind: 'access_point', entity_id: 'device_tracker.ap', position: [1, 2] },
    { id: 'r', kind: 'radio', entity_id: '', position: [2, 2] },
  ];
  p.devices = [
    { id: 'w', entity_id: 'binary_sensor.w', position: [3, 1] },
    { id: 'dup', entity_id: 'sensor.t', position: [3, 2] },
  ];
  return p;
}

const hass = (): Hass => ({
  states: {
    'sensor.t': {
      entity_id: 'sensor.t',
      state: '20',
      attributes: { device_class: 'temperature', unit_of_measurement: '°C' },
      last_reported: '2026-10-24T10:00:00Z',
    },
    'device_tracker.ap': { entity_id: 'device_tracker.ap', state: 'home', attributes: {} },
    'binary_sensor.w': { entity_id: 'binary_sensor.w', state: 'off', attributes: {} },
  },
  callService: async () => undefined,
});

describe('history entities', () => {
  it('splits sensors (for statistics) from everything else, once each', () => {
    expect(planEntities(plan())).toEqual({
      sensors: ['sensor.t', 'sensor.u'],
      others: ['device_tracker.ap', 'binary_sensor.w'],
    });
    expect(planEntities(null)).toEqual({ sensors: [], others: [] });
  });
});

describe('states at a time', () => {
  const tl: Timeline = new Map([
    ['a', { t: [10, 20, 30], s: ['x', 'y', 'z'] }],
    ['b', { t: [25], s: ['only'] }],
    ['c', { t: [], s: [] }],
  ]);
  it('picks the last state at or before the time, else the first', () => {
    const at = (t: number): Record<string, string> => Object.fromEntries(statesAt(tl, t));
    expect(at(5)).toEqual({ a: 'x', b: 'only' });
    expect(at(20)).toEqual({ a: 'y', b: 'only' });
    expect(at(29)).toEqual({ a: 'y', b: 'only' });
    expect(at(1000)).toEqual({ a: 'z', b: 'only' });
  });

  it('builds a read-only hass with recorded states over the live ones', () => {
    const tl2: Timeline = new Map([
      ['sensor.t', { t: [0], s: ['31'] }],
      ['device_tracker.ap', { t: [0], s: ['unavailable'] }],
      ['sensor.gone', { t: [0], s: ['1'] }],
    ]);
    const live = hass();
    const then = hassAt(live, tl2, 5)!;
    expect(then.callService).toBeUndefined();
    expect(then.states!['sensor.t']).toMatchObject({ state: '31', last_reported: undefined });
    expect(then.states!['sensor.t']!.attributes).toEqual(live.states!['sensor.t']!.attributes);
    expect(then.states!['sensor.gone']).toBeUndefined();
    expect(live.states!['sensor.t']!.state).toBe('20');
    // The signal layer follows: the access point was down then.
    const signal = layerData(plan(), then, 'signal');
    expect(signal.readings.map((r) => r.id)).toEqual(['r']);
    expect(signal.excluded.map((r) => r.id)).toEqual(['ap']);
    expect(layerData(plan(), then, 'temperature').readings[0]!.value).toBe(31);
    expect(hassAt(undefined, tl2, 5)).toBeUndefined();
  });
});

describe('fetching the timeline', () => {
  it('uses hourly statistics for sensors that have them and history for the rest', async () => {
    const sent: { type: string; [k: string]: unknown }[] = [];
    const c: HassConnection = {
      async sendMessagePromise<T>(m: { type: string; [k: string]: unknown }): Promise<T> {
        sent.push(m);
        if (m.type === 'recorder/statistics_during_period')
          return {
            'sensor.t': [
              { start: 1000, mean: 20.456 },
              { start: 2000, mean: null },
            ],
            'sensor.u': [{ start: 1000, mean: null }],
          } as T;
        return {
          'sensor.u': [{ s: '5', lu: 1.5 }],
          'binary_sensor.w': [{ s: 'on', lc: 2 }, { s: 'off' }],
        } as T;
      },
    };
    const tl = await fetchTimeline(c, plan(), 0, 3000, 'hour');
    expect(sent.map((m) => m.type)).toEqual([
      'recorder/statistics_during_period',
      'history/history_during_period',
    ]);
    expect(sent[0]).toMatchObject({ statistic_ids: ['sensor.t', 'sensor.u'], period: 'hour' });
    expect(sent[1]!['entity_ids']).toEqual(['sensor.u', 'device_tracker.ap', 'binary_sensor.w']);
    expect(sent[1]).toMatchObject({ minimal_response: true, no_attributes: true });
    expect(tl.get('sensor.t')).toEqual({ t: [1000], s: ['20.46'] });
    expect(tl.get('sensor.u')).toEqual({ t: [1500], s: ['5'] });
    expect(tl.get('binary_sensor.w')).toEqual({ t: [2000, 0], s: ['on', 'off'] });
  });

  it('asks only for history over short ranges', async () => {
    const types: string[] = [];
    const c: HassConnection = {
      async sendMessagePromise<T>(m: { type: string }): Promise<T> {
        types.push(m.type);
        return {} as T;
      },
    };
    expect((await fetchTimeline(c, plan(), 0, 1, null)).size).toBe(0);
    expect(types).toEqual(['history/history_during_period']);
  });
});

describe('build literal minifier', () => {
  it('squeezes CSS without touching values', () => {
    expect(
      squeeze('\n  /* c */\n  .a .b { color: red;\n    margin: 0 calc(8px + 2px); }\n', 'css'),
    ).toBe(' .a .b{color:red;margin:0 calc(8px + 2px)}');
  });
  it('squeezes GLSL, dropping comments', () => {
    expect(squeeze('void main() {\n  // c\n  float a = b * c;\n}\n', 'glsl')).toBe(
      'void main(){\nfloat a=b*c;\n}\n',
    );
  });
  it('folds HTML line breaks into spaces', () => {
    expect(squeeze('<p>\n    a\n  </p>', 'html')).toBe('<p> a </p>');
  });
});
