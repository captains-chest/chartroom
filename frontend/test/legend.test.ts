import { describe, expect, it } from 'vite-plus/test';
import type { LayerData, LayerReading } from '../src/heat';
import { legendContent, signalNote } from '../src/heat/legend';
import { SEG, SRC } from '../src/signal';

const reading = (id: string, value: number): LayerReading => ({
  id,
  entity_id: `sensor.${id}`,
  position: [0, 0],
  value,
});

describe('legend', () => {
  it('shows the range, the readings and what was left out', () => {
    const data: LayerData = {
      layer: 'temperature',
      unit: '°C',
      readings: [reading('a', 19.04), reading('b', 22), reading('c', 25)],
      excluded: [{ id: 'd', entity_id: 'sensor.d', position: [1, 1], reason: 'unavailable' }],
    };
    const c = legendContent(data, [16, 28]);
    expect(c.title).toBe('Temperature');
    expect(c.scale).toEqual(['16.0', '22.0', '28.0']);
    expect(c.note).toEqual(['19.0–25.0 °C', '3 sensors', '1 left out']);
    expect(c.ticks).toEqual([
      { cls: 'min', left: '25.3%', title: 'Lowest reading 19.0 °C' },
      { cls: 'max', left: '75.0%', title: 'Highest reading 25.0 °C' },
    ]);
    expect(c.label).toBe('Temperature 16.0 to 28.0 °C. 19.0–25.0 °C, 3 sensors, 1 left out');
  });

  it('shows the signal note (signalNote), without ticks', () => {
    const data: LayerData = {
      layer: 'signal',
      unit: 'dBm',
      readings: [reading('ap', -40)],
      excluded: [],
    };
    const c = legendContent(data, [-90, -30], ['1 source', '1 wall segment']);
    expect(c.note).toEqual(['1 source', '1 wall segment']);
    expect(c.ticks).toEqual([]);
  });

  it('says when there are no readings', () => {
    const data: LayerData = { layer: 'humidity', unit: '%', readings: [], excluded: [] };
    const c = legendContent(data, [30, 70]);
    expect(c.note).toEqual(['No readings']);
    expect(c.ticks).toEqual([]);
    expect(c.scale).toEqual(['30', '50', '70']);
  });
});

describe('signalNote', () => {
  const input = (sources: number, segments: number, leftOut = { sources: 0, segments: 0 }) => ({
    aps: new Float32Array(sources * SRC),
    walls: new Float32Array(segments * SEG),
    leftOut,
  });

  it('counts the sources and wall segments the map uses', () => {
    expect(signalNote(input(3, 1))).toEqual(['3 sources', '1 wall segment']);
    expect(signalNote(input(1, 0))).toEqual(['1 source', '0 wall segments']);
    expect(signalNote(input(0, 4))).toEqual(['No sources', '4 wall segments']);
  });

  it('says how many it left out over the limits', () => {
    expect(signalNote(input(32, 2048, { sources: 1, segments: 12 }))).toEqual([
      '32 sources',
      '2048 wall segments',
      '1 source left out (limit 32)',
      '12 wall segments left out (limit 2048)',
    ]);
  });
});
