import { describe, expect, it } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import {
  linkQuality,
  meshInfo,
  placeLinks,
  placeRings,
  qualityColour,
  sourceNote,
  type Topology,
  weakSpots,
} from '../src/mesh-layer';
import { emptyPlan } from '../src/plan/functions';

const topology: Topology = {
  nodes: [
    {
      id: 'zha:c',
      source: 'zha',
      name: 'Coordinator',
      role: 'coordinator',
      device_id: 'dev_c',
      entities: [],
    },
    { id: 'zha:p', source: 'zha', name: 'Plug', role: 'router', entities: ['switch.plug'] },
    {
      id: 'zha:d',
      source: 'zha',
      name: 'Door',
      role: 'end_device',
      device_id: 'dev_d',
      entities: [],
    },
    { id: 'zha:x', source: 'zha', name: 'Elsewhere', role: 'router', entities: ['light.far'] },
  ],
  links: [
    { a: 'zha:c', b: 'zha:p', source: 'zha', lqi: 255 },
    { a: 'zha:p', b: 'zha:d', source: 'zha', rssi: -90 },
    { a: 'zha:c', b: 'zha:d', source: 'zha' },
    { a: 'zha:p', b: 'zha:x', source: 'zha', lqi: 100 },
  ],
  sources: { zha: 'ok', zwave_js: 'absent', zigbee2mqtt: 'pending' },
};

describe('mesh links', () => {
  it('rates links by RSSI, else LQI', () => {
    expect(linkQuality({ a: '', b: '', source: '', lqi: 255, rssi: -90 })).toBe(0);
    expect(linkQuality({ a: '', b: '', source: '', lqi: 51 })).toBe(0.2);
    expect(linkQuality({ a: '', b: '', source: '', rssi: -65 })).toBe(0.5);
    expect(linkQuality({ a: '', b: '', source: '', rssi: -20 })).toBe(1);
    expect(linkQuality({ a: '', b: '', source: '' })).toBeNull();
    expect(qualityColour(0)).toBe('hsl(0 75% 40%)');
    expect(qualityColour(1)).toBe('hsl(120 75% 40%)');
  });

  it('places nodes by their entities or their device, and skips unplaced ends', () => {
    const plan = emptyPlan('Mesh');
    plan.devices = [
      { id: 'a', entity_id: 'switch.plug', position: [1, 1] },
      { id: 'b', entity_id: 'binary_sensor.door', position: [4, 1] },
    ];
    plan.sources = [{ id: 's', kind: 'radio', entity_id: 'sensor.coord', position: [0, 3] }];
    const hass: Hass = {
      entities: {
        'binary_sensor.door': { entity_id: 'binary_sensor.door', device_id: 'dev_d' },
        'sensor.coord': { entity_id: 'sensor.coord', device_id: 'dev_c' },
      },
    };
    const links = placeLinks(topology, plan, hass);
    expect(links.map((l) => [l.a, l.b, l.quality])).toEqual([
      [[0, 3], [1, 1], 1],
      [[1, 1], [4, 1], 0],
      [[0, 3], [4, 1], null],
    ]);
    expect(links[0]!.label).toBe('Coordinator – Plug: LQI 255');
    expect(links[2]!.label).toContain('quality unknown');
    expect(sourceNote(topology, links.length)).toBe(
      'Mesh: 3 links on this plan · ZHA, Zigbee2MQTT pending',
    );
  });

  it('names Thread roles and marks links of an offline node', () => {
    const plan = emptyPlan('Thread');
    plan.devices = [
      { id: 'a', entity_id: 'switch.plug', position: [1, 1] },
      { id: 'b', entity_id: 'light.lamp', position: [4, 1] },
    ];
    const thread: Topology = {
      nodes: [
        {
          id: 'm:1',
          source: 'matter',
          name: 'Plug',
          role: 'router',
          thread_role: 'leader',
          entities: ['switch.plug'],
        },
        {
          id: 'm:2',
          source: 'matter',
          name: 'Lamp',
          role: 'router',
          thread_role: 'REED',
          entities: ['light.lamp'],
        },
      ],
      links: [{ a: 'm:1', b: 'm:2', source: 'matter', lqi: 170, rssi: -81, offline: true }],
      sources: { matter: 'ok' },
    };
    const [link] = placeLinks(thread, plan, undefined);
    expect(link!.offline).toBe(true);
    expect(link!.label).toBe(
      'Plug (leader) – Lamp (REED): LQI 170, RSSI -81 dBm (offline, last report)',
    );
    expect(sourceNote(thread, 1)).toBe('Mesh: 1 link on this plan · Matter');
  });

  it("draws neighbours faint and rings routers, and names a device's role and route", () => {
    const plan = emptyPlan('Routes');
    plan.devices = [
      { id: 'a', entity_id: 'switch.plug', position: [1, 1] },
      { id: 'b', entity_id: 'light.lamp', position: [4, 1] },
      { id: 'c', entity_id: 'binary_sensor.door', position: [4, 4] },
    ];
    const node = (id: string, name: string, role: string, extra = {}) => ({
      id,
      source: 'matter',
      name,
      role,
      entities: [],
      ...extra,
    });
    const t: Topology = {
      nodes: [
        node('br', 'Border router', 'coordinator', { thread_role: 'border router' }),
        node('p', 'Plug', 'router', { via: 'br', entities: ['switch.plug'] }),
        node('l', 'Lamp', 'router', { thread_role: 'REED', entities: ['light.lamp'] }),
        node('d', 'Door', 'end_device', { via: 'p', device_id: 'dev_d' }),
      ],
      links: [
        { a: 'br', b: 'p', source: 'matter', lqi: 255, relationship: 'route' },
        { a: 'd', b: 'p', source: 'matter', rssi: -70, relationship: 'parent' },
        { a: 'l', b: 'p', source: 'matter', rssi: -60, relationship: 'neighbor' },
      ],
      sources: { matter: 'ok' },
    };
    const hass: Hass = {
      entities: { 'binary_sensor.door': { entity_id: 'binary_sensor.door', device_id: 'dev_d' } },
    };
    const links = placeLinks(t, plan, hass);
    expect(links.map((l) => [l.key, l.faint])).toEqual([
      ['d p', false],
      ['l p', true],
    ]);
    expect(links[0]!.label).toBe('Door – Plug: RSSI -70 dBm · parent link');
    expect(placeRings(t, plan, hass).map((n) => n.ring)).toEqual(['router', 'reed']);
    const door = meshInfo(t, ['binary_sensor.door'], null, hass);
    expect(door.lines).toEqual([
      'Thread end device',
      'Route: → Plug (RSSI -70 dBm) → Border router (LQI 255) · 2 hops',
    ]);
    expect([...door.path]).toEqual(['d p', 'br p']);
    expect(meshInfo(t, ['light.lamp'], null, hass).lines).toEqual([
      'Thread REED: can route, does not yet',
      'Route: not reported',
    ]);
  });

  it('says when there is no network', () => {
    expect(sourceNote({ nodes: [], links: [], sources: { zha: 'absent' } }, 0)).toContain('no ZHA');
    expect(sourceNote(null, 0)).toBe('Mesh: loading…');
    expect(sourceNote(null, 0, 'boom')).toBe('Mesh: boom');
  });
});

describe('weak spots', () => {
  const node = (id: string, role: string, via?: string, extra = {}) => ({
    id,
    source: 'zha',
    name: id,
    role,
    via: via ?? null,
    ...extra,
  });

  it('flags a device whose only parent link is poor, by RSSI when it has one', () => {
    const t: Topology = {
      nodes: [
        node('c', 'coordinator'),
        node('lqi', 'end_device', 'c'),
        node('rssi', 'end_device', 'c'),
        node('fine', 'end_device', 'c'),
        node('reed', 'router', 'c', { thread_role: 'REED' }),
        node('r', 'router', 'c'),
        // `via` decides: a good neighbour marked parent does not hide a poor via link...
        node('viaPoor', 'end_device', 'c'),
        // ...and a poor parent-marked link to another node is not its parent.
        node('noLink', 'end_device', 'c'),
        // Without `via`, its one parent-marked link is.
        node('noVia', 'end_device'),
      ],
      links: [
        { a: 'c', b: 'lqi', source: 'zha', lqi: 62, relationship: 'parent' },
        { a: 'c', b: 'rssi', source: 'zha', lqi: 200, rssi: -91 },
        { a: 'c', b: 'fine', source: 'zha', lqi: 40, rssi: -70, relationship: 'parent' },
        // A REED does not route yet: it hangs on its parent like an end device.
        { a: 'c', b: 'reed', source: 'zha', rssi: -86, relationship: 'parent' },
        // A router has other ways out.
        { a: 'c', b: 'r', source: 'zha', lqi: 10, relationship: 'route' },
        { a: 'c', b: 'viaPoor', source: 'zha', lqi: 30, relationship: 'parent' },
        { a: 'r', b: 'viaPoor', source: 'zha', lqi: 250, relationship: 'parent' },
        { a: 'r', b: 'noLink', source: 'zha', lqi: 20, relationship: 'parent' },
        { a: 'r', b: 'noVia', source: 'zha', lqi: 70, relationship: 'parent' },
      ],
      sources: { zha: 'ok' },
    };
    expect(Object.fromEntries(weakSpots(t))).toEqual({
      lqi: 'Weak: only parent link is poor (LQI 62)',
      rssi: 'Weak: only parent link is poor (RSSI -91 dBm)',
      reed: 'Weak: only parent link is poor (RSSI -86 dBm)',
      viaPoor: 'Weak: only parent link is poor (LQI 30)',
      noVia: 'Weak: only parent link is poor (LQI 70)',
    });
  });

  it('flags a router that many devices route through, two hops down too', () => {
    const t: Topology = {
      nodes: [
        node('c', 'coordinator'),
        node('r1', 'router', 'c', { entities: ['switch.plug'] }),
        node('r2', 'router', 'r1'),
        node('e1', 'end_device', 'r2'),
        node('e2', 'end_device', 'r2'),
        node('e3', 'end_device', 'c'),
      ],
      links: [],
      sources: { zha: 'ok' },
    };
    // r1 carries r2 and, through it, e1 and e2; r2 only two; the coordinator is not counted.
    expect(Object.fromEntries(weakSpots(t))).toEqual({
      r1: 'Weak: 3 devices route through this',
    });
    const plan = emptyPlan('Weak');
    plan.devices = [{ id: 'a', entity_id: 'switch.plug', position: [1, 1] }];
    expect(placeRings(t, plan, undefined)).toEqual([{ at: [1, 1], ring: 'router', weak: true }]);
    expect(meshInfo(t, ['switch.plug'], null, undefined).lines).toEqual([
      'Zigbee router',
      'Route: → c · 1 hop',
      'Weak: 3 devices route through this',
    ]);
  });
});
