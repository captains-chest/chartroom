// Heatmap layers: which sensors feed each layer, their values, the colour ramps and the value
// range. Pure functions (no DOM), shared by the panel, the card and the tests.
import type { EntityState, Hass } from './ha-types';
import { DEFAULT_TX_DBM, isSignalSource, type Plan, type Point } from './plan';

export type HeatLayerId = 'temperature' | 'humidity' | 'signal';
export const HEAT_LAYERS: readonly HeatLayerId[] = ['temperature', 'humidity', 'signal'];

/** Colour stops: position 0..1 and sRGB. */
export type RampStop = readonly [number, number, number, number];

export interface LayerSpec {
  id: HeatLayerId;
  label: string;
  ramp: readonly RampStop[];
  /** The range the ramp spans at least, per unit; it grows to include the readings. */
  domain: Record<string, readonly [number, number]>;
  /** Decimals for labels. */
  digits: number;
  /** The range is fixed (it does not grow to include the readings). */
  fixed?: boolean;
}

export const LAYERS: Record<HeatLayerId, LayerSpec> = {
  temperature: {
    id: 'temperature',
    label: 'Temperature',
    // Blue, cyan, green, yellow, red (the plan Page's ramp).
    ramp: [
      [0, 40, 70, 210],
      [0.25, 0, 185, 225],
      [0.5, 70, 200, 80],
      [0.75, 250, 215, 40],
      [1, 225, 40, 30],
    ],
    domain: { '°C': [16, 28], '°F': [61, 82], K: [289, 301] },
    digits: 1,
  },
  humidity: {
    id: 'humidity',
    label: 'Humidity',
    // Dry sand, pale yellow, mint, cyan-blue, deep blue.
    ramp: [
      [0, 205, 150, 75],
      [0.25, 240, 220, 130],
      [0.5, 120, 210, 160],
      [0.75, 40, 160, 215],
      [1, 25, 60, 170],
    ],
    domain: { '%': [30, 70] },
    digits: 0,
  },
  signal: {
    id: 'signal',
    label: 'Signal',
    // Dead grey-violet, red, amber, yellow-green, green: weak to strong.
    ramp: [
      [0, 70, 60, 90],
      [0.25, 200, 50, 50],
      [0.5, 245, 160, 40],
      [0.75, 175, 210, 60],
      [1, 40, 170, 80],
    ],
    domain: { dBm: [-90, -30] },
    digits: 0,
    fixed: true,
  },
};

/** The layer a sensor belongs to, from its device class (or, failing that, its unit). */
export function layerOfState(st: EntityState): HeatLayerId | null {
  const dc = st.attributes.device_class;
  const unit = st.attributes.unit_of_measurement;
  if (dc === 'temperature') return 'temperature';
  if (dc === 'humidity') return 'humidity';
  if (!dc && (unit === '°C' || unit === '°F')) return 'temperature';
  return null;
}

/** A sensor reading used by a layer, or why a placed sensor was left out. */
export interface LayerReading {
  id: string;
  entity_id: string;
  position: Point;
  value: number;
}

export interface LayerData {
  layer: HeatLayerId;
  unit: string;
  readings: LayerReading[];
  /** Placed sensors of this layer that were left out (unavailable, unknown, not a number…). */
  excluded: { id: string; entity_id: string; position: Point; reason: string }[];
}

const toUnit = (v: number, from: string, to: string): number => {
  if (from === to) return v;
  const c = from === '°F' ? ((v - 32) * 5) / 9 : from === 'K' ? v - 273.15 : v;
  return to === '°F' ? (c * 9) / 5 + 32 : to === 'K' ? c + 273.15 : c;
};

/** Readings older than this (by `last_reported`, when Home Assistant sends it) are stale. */
export const STALE_MS = 6 * 3600_000;

/** The sensors on `plan` that feed `layer`, with numeric values in one unit. */
export function layerData(
  plan: Plan | null,
  hass: Hass | undefined,
  layer: HeatLayerId,
  now = Date.now(),
): LayerData {
  const readings: LayerReading[] = [];
  const excluded: LayerData['excluded'] = [];
  if (layer === 'signal') {
    // Access points and radios: their level at 1 m. One whose entity is unavailable is down.
    for (const src of plan?.sources ?? []) {
      if (!isSignalSource(src)) continue;
      const { id, entity_id, position } = src;
      if (hass?.states?.[entity_id]?.state === 'unavailable')
        excluded.push({ id, entity_id, position, reason: 'unavailable' });
      else {
        const value = src.tx_dbm ?? DEFAULT_TX_DBM[src.kind as 'radio'];
        readings.push({ id, entity_id, position, value });
      }
    }
    return { layer, unit: 'dBm', readings, excluded };
  }
  let unit = '';
  const raw: { s: LayerReading; unit: string }[] = [];
  for (const src of plan?.sources ?? []) {
    if (src.kind !== 'sensor' || !src.entity_id) continue;
    const st = hass?.states?.[src.entity_id];
    if (!st || layerOfState(st) !== layer) continue;
    const u = st.attributes.unit_of_measurement ?? '';
    const value = Number(st.state);
    const reported = st.last_reported ? Date.parse(st.last_reported) : NaN;
    let reason = '';
    if (st.state === 'unavailable' || st.state === 'unknown') reason = st.state;
    else if (st.state.trim() === '' || !Number.isFinite(value)) reason = 'not a number';
    else if (Number.isFinite(reported) && now - reported > STALE_MS) reason = 'stale';
    if (reason) {
      excluded.push({ id: src.id, entity_id: src.entity_id, position: src.position, reason });
      continue;
    }
    if (!unit) unit = u;
    raw.push({
      s: { id: src.id, entity_id: src.entity_id, position: src.position, value },
      unit: u,
    });
  }
  for (const { s, unit: u } of raw)
    readings.push({ ...s, value: layer === 'temperature' ? toUnit(s.value, u, unit) : s.value });
  if (!unit) unit = layer === 'temperature' ? '°C' : '%';
  return { layer, unit, readings, excluded };
}

/** The ramp's value range: the layer's default for the unit, widened to whole numbers around the data. */
export function layerDomain(
  layer: HeatLayerId,
  unit: string,
  values: readonly number[],
): [number, number] {
  const spec = LAYERS[layer];
  const d = spec.domain[unit] ?? Object.values(spec.domain)[0]!;
  let lo = d[0];
  let hi = d[1];
  if (spec.fixed) return [lo, hi];
  for (const v of values) {
    if (v < lo) lo = Math.floor(v);
    if (v > hi) hi = Math.ceil(v);
  }
  return [lo, hi];
}

/** The ramp as 256 RGBA entries (alpha 255): the texture both renderers sample. */
export function rampLut(stops: readonly RampStop[]): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const a = stops[k]!;
    const b = stops[Math.min(k + 1, stops.length - 1)]!;
    const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] = Math.round(a[c + 1]! + (b[c + 1]! - a[c + 1]!) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** CSS gradient for the legend, from the same stops. */
export const rampCss = (stops: readonly RampStop[]): string =>
  `linear-gradient(to right, ${stops.map(([t, r, g, b]) => `rgb(${r} ${g} ${b}) ${Math.round(t * 100)}%`).join(', ')})`;

/** Ease-out (cubic) used for value transitions. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** Transition length for value and layout changes, in ms (docs/render-design.md). */
export const TRANSITION_MS = 600;

/** A stable key for the sensor layout: re-triangulate only when it changes. */
export const layoutKey = (readings: readonly LayerReading[], outline: readonly Point[]): string =>
  readings.map((r) => `${r.id}@${r.position[0]},${r.position[1]}`).join(';') +
  '|' +
  outline.map((p) => p.join(',')).join(';');

/** Placed sources per layer (whatever their state), to enable the layer buttons. */
export function layerCounts(
  plan: Plan | null,
  hass: Hass | undefined,
): Record<HeatLayerId, number> {
  const out: Record<HeatLayerId, number> = { temperature: 0, humidity: 0, signal: 0 };
  for (const src of plan?.sources ?? []) {
    if (isSignalSource(src)) out.signal++;
    if (src.kind !== 'sensor' || !src.entity_id) continue;
    const st = hass?.states?.[src.entity_id];
    const layer = st ? layerOfState(st) : null;
    if (layer) out[layer]++;
  }
  return out;
}

export const isHeatLayer = (v: unknown): v is HeatLayerId => HEAT_LAYERS.includes(v as HeatLayerId);
