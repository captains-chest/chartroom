import { describe, expect, it } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import {
  linkQuality,
  placeLinks,
  qualityColour,
  sourceNote,
  type Topology,
} from '../src/mesh-layer';
import { emptyPlan } from '../src/plan';

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
  it('rates links by LQI, else RSSI', () => {
    expect(linkQuality({ a: '', b: '', source: '', lqi: 255, rssi: -90 })).toBe(1);
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

  it('says when there is no network', () => {
    expect(sourceNote({ nodes: [], links: [], sources: { zha: 'absent' } }, 0)).toContain('no ZHA');
    expect(sourceNote(null, 0)).toBe('Mesh: loading…');
    expect(sourceNote(null, 0, 'boom')).toBe('Mesh: boom');
  });
});
