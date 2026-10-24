// The signal-strength model (docs/render-design.md, "Signal strength"): straight rays from each
// access point or radio, log-distance path loss from its level at 1 m, minus the loss of every wall
// segment the ray crosses (material dB/cm x thickness; doors and windows are segments of their own,
// free when their sensor says open), the strongest source winning. Pure, so the worker (Canvas2D
// fallback), the tests and the WebGL2 shader's agreement check all use this one definition.
import { fadeAt, type FieldGrid } from './field';
import type { Hass } from './ha-types';
import {
  lossDb,
  materialsOf,
  pointAlong,
  wallLength,
  type Opening,
  type Plan,
  type Point,
} from './plan';

/** Path-loss exponent: 2 in free space, 2-3 indoors. */
export const SIGNAL_N = 2.2;
/** Below the weakest level anything shows; also the value with no source. */
export const SIGNAL_FLOOR = -120;
/** Shader limits: sources go in a uniform array, wall segments in a texture row. */
export const MAX_SIGNAL_SOURCES = 32;
export const MAX_SIGNAL_SEGMENTS = 2048;
/** Grid cells along the longer side: the signal pass is heavier than the sensor field. */
export const SIGNAL_CELLS = 128;
/** Floats per wall segment (ax, ay, bx, by, loss dB) and per source (x, y, level dBm). */
export const SEG = 5;
export const SRC = 3;

export interface SignalInput {
  walls: Float32Array;
  aps: Float32Array;
}

/** States of a door or window sensor (binary_sensor on, cover open...) that mean "open". */
const OPEN = new Set(['on', 'open', 'opening', 'closing']);

/** Wall segments with their loss: each wall split at its doors and windows. Zero-loss parts are left out. */
export function wallSegments(plan: Plan, hass?: Hass): number[] {
  const mats = materialsOf(plan);
  const loss = (material: string, thickness: number): number => {
    const m = mats.get(material);
    return m ? lossDb(m, thickness) : 0;
  };
  const openings = new Map<string, Opening[]>();
  for (const o of [...plan.doors, ...plan.windows])
    openings.set(o.wall, [...(openings.get(o.wall) ?? []), o]);
  const out: number[] = [];
  const push = (a: Point, b: Point, db: number): void => {
    if (db > 0 && (a[0] !== b[0] || a[1] !== b[1])) out.push(a[0], a[1], b[0], b[1], db);
  };
  for (const w of plan.walls) {
    const len = wallLength(w);
    if (!(len > 0)) continue;
    const wallDb = loss(w.material, w.thickness);
    let at = 0;
    const list = [...(openings.get(w.id) ?? [])].sort((p, q) => p.offset - q.offset);
    for (const o of list) {
      const s = Math.min(len, Math.max(at, o.offset));
      const e = Math.min(len, Math.max(s, o.offset + o.width));
      push(pointAlong(w, at), pointAlong(w, s), wallDb);
      const open = !!o.entity_id && OPEN.has(hass?.states?.[o.entity_id]?.state ?? '');
      push(pointAlong(w, s), pointAlong(w, e), open ? 0 : loss(o.material, o.thickness));
      at = e;
    }
    push(pointAlong(w, at), w.b, wallDb);
  }
  return out;
}

/**
 * Everything the signal pass needs, packed as the shader takes it (and capped to its limits).
 * `sources` are the signal layer's readings: position and level at 1 m.
 */
export function signalInput(
  plan: Plan,
  hass: Hass | undefined,
  sources: readonly { position: Point; value: number }[],
): SignalInput {
  const aps = sources
    .slice(0, MAX_SIGNAL_SOURCES)
    .flatMap((s) => [s.position[0], s.position[1], s.value]);
  return {
    walls: new Float32Array(wallSegments(plan, hass).slice(0, MAX_SIGNAL_SEGMENTS * SEG)),
    aps: new Float32Array(aps),
  };
}

/** Received level at (x, y) in dBm. The loops and tests mirror the shader exactly. */
export function signalAt(input: SignalInput, x: number, y: number, n = SIGNAL_N): number {
  const { walls, aps } = input;
  let best = SIGNAL_FLOOR;
  for (let k = 0; k + SRC <= aps.length; k += SRC) {
    const ax = aps[k]!;
    const ay = aps[k + 1]!;
    const rx0 = x - ax;
    const ry0 = y - ay;
    let rx = aps[k + 2]! - 10 * n * Math.log10(Math.max(Math.hypot(rx0, ry0), 1));
    if (rx <= best) continue;
    for (let w = 0; w + SEG <= walls.length; w += SEG) {
      const qx = walls[w]! - ax;
      const qy = walls[w + 1]! - ay;
      const ex = walls[w + 2]! - walls[w]!;
      const ey = walls[w + 3]! - walls[w + 1]!;
      const den = rx0 * ey - ry0 * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (qx * ey - qy * ex) / den;
      const u = (qx * ry0 - qy * rx0) / den;
      if (t > 0 && t <= 1 && u >= 0 && u <= 1) {
        rx -= walls[w + 4]!;
        if (rx <= best) break;
      }
    }
    if (rx > best) best = rx;
  }
  return best;
}

/** The signal field over a grid: value (dBm), confidence (1) and the outside fade per cell. */
export function signalField(
  input: SignalInput,
  grid: FieldGrid,
  outline: readonly Point[],
): Float32Array {
  const out = new Float32Array(grid.nx * grid.ny * 3);
  for (let j = 0; j < grid.ny; j++) {
    const y = grid.y0 + (j + 0.5) * grid.cell;
    for (let i = 0; i < grid.nx; i++) {
      const x = grid.x0 + (i + 0.5) * grid.cell;
      const c = (j * grid.nx + i) * 3;
      out[c] = signalAt(input, x, y);
      out[c + 1] = 1;
      out[c + 2] = fadeAt(outline, x, y);
    }
  }
  return out;
}

/** A cheap fingerprint of the packed input, to tell when the field must be recomputed. */
export function signalKey(input: SignalInput): string {
  let h = 0x811c9dc5;
  for (const a of [input.walls, input.aps])
    for (const v of new Uint32Array(a.buffer, a.byteOffset, a.length))
      h = Math.imul(h ^ v, 16777619);
  return `${input.walls.length / SEG}w${input.aps.length / SRC}s${(h >>> 0).toString(36)}`;
}
