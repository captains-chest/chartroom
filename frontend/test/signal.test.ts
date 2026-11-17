import { describe, expect, it } from 'vite-plus/test';
import { fieldGrid } from '../src/field';
import type { Hass } from '../src/ha-types';
import { layerCounts, layerData, layerDomain } from '../src/heat/functions';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import type { Point } from '../src/plan/types';
import {
  MAX_SIGNAL_SEGMENTS,
  MAX_SIGNAL_SOURCES,
  SEGMENT_STRIDE,
  SIGNAL_FLOOR,
  SIGNAL_N,
  SOURCE_STRIDE,
  signalAt,
  signalField,
  signalInput,
  signalKey,
  signalLimitWarnings,
  wallSegments,
} from '../src/signal';
import { fitLevel, meshNetworks, meshSignal, pathLoss } from '../src/signal-mesh';
import type { Topology } from '../src/mesh-layer';
import { createHandler } from '../src/worker-protocol';

/** A 6 m x 4 m room split by a partition at x = 3 with a door in it; an AP in the left half. */
function setup(): { plan: Plan; hass: Hass } {
  const plan = emptyPlan('Signal');
  plan.walls = [
    { id: 'p', a: [3, 0], b: [3, 4], thickness: 0.1, material: 'partition' },
    { id: 'x', a: [5, 0], b: [5, 4], thickness: 0.3, material: 'exterior' },
  ];
  plan.doors = [
    {
      id: 'd',
      wall: 'p',
      offset: 1,
      width: 1,
      material: 'wood_door',
      thickness: 0.04,
      hinge: 'a',
      swing: 1,
      entity_id: 'binary_sensor.door',
    },
  ];
  plan.sources = [
    {
      id: 'ap',
      kind: 'access_point',
      entity_id: 'device_tracker.ap',
      position: [1, 3],
      tx_dbm: -30,
    },
    { id: 'r', kind: 'radio', entity_id: '', position: [1, 0.5] },
  ];
  plan.devices = [{ id: 's', entity_id: 'sensor.t', position: [2, 2] }];
  const hass: Hass = {
    states: {
      'binary_sensor.door': { entity_id: 'binary_sensor.door', state: 'off', attributes: {} },
    },
  };
  return { plan, hass };
}

const free = (level: number, d: number): number =>
  level - 10 * SIGNAL_N * Math.log10(Math.max(d, 1));

describe('signal layer readings', () => {
  it('uses access points and radios with their level at 1 m', () => {
    const { plan, hass } = setup();
    const data = layerData(plan, hass, 'signal');
    expect(data.unit).toBe('dBm');
    expect(data.readings.map((r) => [r.id, r.value])).toEqual([
      ['ap', -30],
      ['r', -45],
    ]);
    // Its one device could be a mesh router.
    expect(layerCounts(plan, hass).signal).toBe(3);
    expect(layerDomain('signal', 'dBm', [-10, -200])).toEqual([-90, -30]);
  });

  it('leaves out a source whose entity is unavailable', () => {
    const { plan, hass } = setup();
    hass.states!['device_tracker.ap'] = {
      entity_id: 'device_tracker.ap',
      state: 'unavailable',
      attributes: {},
    };
    const data = layerData(plan, hass, 'signal');
    expect(data.readings.map((r) => r.id)).toEqual(['r']);
    expect(data.excluded.map((r) => r.id)).toEqual(['ap']);
  });
});

describe('wall segments', () => {
  it('splits walls at their openings with each part’s own loss', () => {
    const { plan, hass } = setup();
    const segs = wallSegments(plan, hass);
    expect(segs.length / SEGMENT_STRIDE).toBe(4);
    const rows = Array.from({ length: segs.length / SEGMENT_STRIDE }, (_, i) =>
      segs.slice(i * SEGMENT_STRIDE, i * SEGMENT_STRIDE + SEGMENT_STRIDE),
    );
    // partition 0.3 dB/cm x 10 cm; door 0.75 x 4; exterior 0.5 x 30.
    expect(rows[0]).toEqual([3, 0, 3, 1, 3]);
    expect(rows[1]![4]).toBeCloseTo(3);
    expect(rows[1]!.slice(0, 4)).toEqual([3, 1, 3, 2]);
    expect(rows[2]).toEqual([3, 2, 3, 4, 3]);
    expect(rows[3]).toEqual([5, 0, 5, 4, 15]);
  });

  it('drops an open door (it costs nothing)', () => {
    const { plan, hass } = setup();
    hass.states!['binary_sensor.door']!.state = 'on';
    expect(wallSegments(plan, hass).length / SEGMENT_STRIDE).toBe(3);
  });

  /** A plan with `n` separate partition walls, one segment each. */
  const walls = (n: number): Plan => {
    const plan = emptyPlan('Many');
    plan.walls = Array.from({ length: n }, (_, i) => ({
      id: `w${i}`,
      a: [i, 0] as [number, number],
      b: [i, 1] as [number, number],
      thickness: 0.1,
      material: 'partition',
    }));
    return plan;
  };

  it('caps the segment count and says how many it left out', () => {
    const input = signalInput(walls(MAX_SIGNAL_SEGMENTS + 10), undefined, []);
    expect(input.walls.length).toBe(MAX_SIGNAL_SEGMENTS * SEGMENT_STRIDE);
    expect(input.leftOut).toEqual({ sources: 0, segments: 10 });
  });

  it('caps the sources and says how many it left out', () => {
    const sources = Array.from({ length: MAX_SIGNAL_SOURCES + 8 }, (_, i) => ({
      position: [i, 0] as Point,
      value: -40,
    }));
    const input = signalInput(walls(1), undefined, sources);
    expect(input.aps.length).toBe(MAX_SIGNAL_SOURCES * SOURCE_STRIDE);
    expect(input.leftOut).toEqual({ sources: 8, segments: 0 });
    expect(signalInput(walls(1), undefined, sources.slice(0, 2)).leftOut.sources).toBe(0);
  });

  it('warns in the editor when the walls make more segments than the signal map takes', () => {
    expect(signalLimitWarnings(walls(MAX_SIGNAL_SEGMENTS))).toEqual([]);
    const [w, ...rest] = signalLimitWarnings(walls(MAX_SIGNAL_SEGMENTS + 3));
    expect(rest).toEqual([]);
    expect(w).toMatch(/2051 wall segments .*more than 2048.*leaves out the rest/);
  });
});

describe('signalAt', () => {
  const one = (plan: Plan, hass: Hass, id: string) =>
    signalInput(
      plan,
      hass,
      layerData(plan, hass, 'signal').readings.filter((r) => r.id === id),
    );

  it('is the level at 1 m within a metre, then falls with log distance', () => {
    const { plan, hass } = setup();
    const input = one(plan, hass, 'ap');
    expect(signalAt(input, 1.5, 3)).toBeCloseTo(-30);
    expect(signalAt(input, 1, 1)).toBeCloseTo(free(-30, 2));
  });

  it('subtracts every wall the ray crosses', () => {
    const { plan, hass } = setup();
    const input = one(plan, hass, 'ap');
    // From (1,3) to (4,3): crosses the partition below the door.
    expect(signalAt(input, 4, 3)).toBeCloseTo(free(-30, 3) - 3);
    // To (6,3): the partition and the exterior wall.
    expect(signalAt(input, 6, 3)).toBeCloseTo(free(-30, 5) - 3 - 15);
    // Through the closed door at y = 1.5 (ray from (1,3) to (5,0) crosses x=3 at y=1.5)... then
    // the exterior wall at x = 5 is reached at t = 1 (the end of the ray counts).
    expect(signalAt(input, 4, 0.75)).toBeCloseTo(free(-30, Math.hypot(3, 2.25)) - 3);
  });

  it('takes the strongest source', () => {
    const { plan, hass } = setup();
    plan.sources[0]!.tx_dbm = -70;
    const input = signalInput(plan, hass, layerData(plan, hass, 'signal').readings);
    // Near the radio it wins; at the access point, the AP (-70) still beats the radio 2.5 m off.
    expect(signalAt(input, 1, 0.6)).toBeCloseTo(-45);
    expect(signalAt(input, 1, 3)).toBeCloseTo(Math.max(-70, free(-45, 2.5)));
  });

  it('is the floor with no sources', () => {
    expect(signalAt({ walls: new Float32Array(), aps: new Float32Array() }, 0, 0)).toBe(
      SIGNAL_FLOOR,
    );
  });
});

describe('signal field and worker', () => {
  it('fills a grid, and the worker gives the same field', () => {
    const { plan, hass } = setup();
    const input = signalInput(plan, hass, layerData(plan, hass, 'signal').readings);
    const grid = fieldGrid({ minX: 0, minY: 0, maxX: 6, maxY: 4 }, 0.5, 32);
    const outline: [number, number][] = [
      [0, 0],
      [5, 0],
      [5, 4],
      [0, 4],
    ];
    const field = signalField(input, grid, outline);
    expect(field.length).toBe(grid.nx * grid.ny * 3);
    const handle = createHandler();
    const res = handle({ type: 'signal', id: 1, key: 'k', grid, outline, ...input });
    expect(res.type).toBe('field');
    if (res.type === 'field') expect(Array.from(res.field)).toEqual(Array.from(field));
    const bad = handle({
      type: 'signal',
      id: 2,
      key: 'k',
      grid: { ...grid, nx: 0 },
      outline,
      ...input,
    });
    expect(bad.type).toBe('error');
  });

  it('keys change with the walls, doors and sources', () => {
    const { plan, hass } = setup();
    const readings = layerData(plan, hass, 'signal').readings;
    const a = signalKey(signalInput(plan, hass, readings));
    expect(signalKey(signalInput(plan, hass, readings))).toBe(a);
    hass.states!['binary_sensor.door']!.state = 'on';
    expect(signalKey(signalInput(plan, hass, readings))).not.toBe(a);
  });
});

describe('signal from the mesh', () => {
  it('fits one level at 1 m to measured links through walls, and needs a few', () => {
    const { plan, hass } = setup();
    const walls = signalInput(plan, hass, []).walls;
    const spots: Point[] = [
      [1, 1],
      [4, 1],
      [2, 3.5],
      [4.5, 3],
      [5.5, 2],
    ];
    const links = spots.flatMap((a, i) =>
      spots.slice(i + 1).map((b, j) => ({
        a,
        b,
        // Measured at -50 dBm @1 m, give or take 2 dB.
        rssi: -50 - pathLoss(walls, a, b) + (j % 2 ? 2 : -2),
      })),
    );
    // Some links lose more than distance alone: through the partition or the exterior wall.
    const dist = (l: (typeof links)[number]): number =>
      Math.hypot(l.a[0] - l.b[0], l.a[1] - l.b[1]);
    expect(links.some((l) => pathLoss(walls, l.a, l.b) > -free(0, dist(l)) + 3)).toBe(true);
    const fit = fitLevel(links, walls)!;
    expect(fit.links).toBe(10);
    expect(fit.level).toBeCloseTo(-50, 0);
    expect(fit.rms).toBeGreaterThan(1.5);
    expect(fit.rms).toBeLessThan(2.5);
    expect(fitLevel(links.slice(0, 2), walls)).toBeNull();
    expect(fitLevel([{ ...links[0]!, rssi: NaN }, ...links.slice(1, 3)], walls)).toBeNull();
  });

  it("makes the placed routers of each network sources, at a typed level when there's no RSSI", () => {
    const { plan, hass } = setup();
    plan.devices = [
      { id: 'p', entity_id: 'switch.plug', position: [2, 1] },
      { id: 'b', entity_id: 'light.bulb', position: [4, 3] },
      { id: 'o', entity_id: 'light.off', position: [4, 1] },
      { id: 's', entity_id: 'sensor.t', position: [2, 2] },
      { id: 'w', entity_id: 'switch.wave', position: [5, 3] },
    ];
    // The radio is the Zigbee coordinator, typed at -48 dBm.
    plan.sources[1] = { ...plan.sources[1]!, entity_id: 'binary_sensor.zigbee', tx_dbm: -48 };
    for (const e of ['light.off', 'switch.wave'])
      hass.states![e] = { entity_id: e, state: 'unavailable', attributes: {} };
    const node = (id: string, source: string, role: string, entity: string) => ({
      id,
      source,
      name: id,
      role,
      entities: [entity],
    });
    const topology: Topology = {
      nodes: [
        node('z:c', 'zha', 'coordinator', 'binary_sensor.zigbee'),
        node('z:s', 'zha', 'end_device', 'sensor.t'),
        node('z:p', 'zigbee2mqtt', 'router', 'switch.plug'),
        node('t:b', 'matter', 'router', 'light.bulb'),
        node('t:o', 'matter', 'router', 'light.off'),
        node('t:x', 'matter', 'router', 'light.nowhere'),
        node('w:r', 'zwave_js', 'router', 'switch.wave'),
      ],
      links: [
        { a: 'z:c', b: 'z:s', source: 'zha', lqi: 200 },
        { a: 'z:p', b: 'z:s', source: 'zha', lqi: 120 },
        { a: 't:b', b: 't:o', source: 'matter', rssi: -60 },
      ],
      sources: {},
    };
    const [zigbee, thread, zwave, ...rest] = meshNetworks(topology, plan, hass);
    expect(rest).toEqual([]);
    // Ranked by placed routers whether or not they are up; one with all down stays, with none up.
    expect([zigbee!.routers, thread!.routers, zwave!.routers]).toEqual([2, 2, 1]);
    expect(meshSignal(zwave!, new Float32Array()).note).toMatch(/^Z-Wave · 0 routers · /);
    // Zigbee: the coordinator (at the radio) and the plug; the sensor is an end device.
    expect(zigbee!.name).toBe('Zigbee');
    const z = meshSignal(zigbee!, signalInput(plan, hass, []).walls);
    expect(z.sources).toEqual([
      { id: 'z:c', position: [1, 0.5], value: -48 },
      { id: 'z:p', position: [2, 1], value: -48 },
    ]);
    expect(z.fit).toBeNull();
    expect(z.note).toBe('Zigbee · 2 routers · -48 dBm @1 m (typed; no RSSI to fit)');
    // Thread: the bulb; the unavailable one is left out, the unplaced one not there at all.
    const t = meshSignal(thread!, signalInput(plan, hass, []).walls);
    expect(t.sources.map((s) => [s.id, s.value])).toEqual([['t:b', -45]]);
    expect(t.down.map((s) => s.id)).toEqual(['t:o']);
    expect(t.note).toBe('Thread · 1 router · -45 dBm @1 m (default; 1 measured, too few to fit)');
  });
});
