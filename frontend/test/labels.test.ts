import { describe, expect, it } from 'vite-plus/test';
import { declutter } from '../src/labels';

const room = (x: number, y: number) => ({
  name: { x, y, size: 0.32, chars: 7 },
  area: { x, y: y + 0.3, size: 0.24, chars: 7 },
});

describe('declutter', () => {
  it('leaves labels alone when there is room', () => {
    const r = declutter([{ x: 0, y: 3, chars: 5 }], [room(0, 0)], 0.01);
    expect(r).toEqual({ values: ['above'], areas: [false] });
  });

  it('hides an area label a value label lands on', () => {
    // The value sits 10 px (0.1 m) above y = 0.45, on the area text (baseline 0.3).
    const r = declutter([{ x: 0, y: 0.45, chars: 5 }], [room(0, 0)], 0.01);
    expect(r).toEqual({ values: ['above'], areas: [true] });
  });

  it('moves a value label below its sensor when it would cover a name', () => {
    const r = declutter([{ x: 0, y: 0.1, chars: 5 }], [room(0, 0)], 0.01);
    expect(r.values).toEqual(['below']);
  });

  it('hides a value label with nowhere to go', () => {
    // A small card, 5 cm per pixel: the 12 px label is 0.6 m tall, with a room name either side.
    const r = declutter([{ x: 0, y: 0.6, chars: 5 }], [room(0, 0), room(0, 1.4)], 0.05);
    expect(r.values).toEqual(['hidden']);
    expect(r.areas).toEqual([true, true]);
  });

  it('keeps value labels off each other', () => {
    const r = declutter(
      [
        { x: 5, y: 5, chars: 5 },
        { x: 5.05, y: 5, chars: 5 },
        { x: 5.1, y: 5, chars: 5 },
      ],
      [],
      0.01,
    );
    expect(r.values).toEqual(['above', 'below', 'hidden']);
  });

  it('hides area labels too small to read', () => {
    expect(declutter([], [room(0, 0)], 0.05).areas).toEqual([true]);
    expect(declutter([], [room(0, 0)], 0.02).areas).toEqual([false]);
  });
});
