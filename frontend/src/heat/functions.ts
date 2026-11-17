// Heatmap layers: which sensors feed each layer, their values, the colour ramps and the value
// range. Pure functions (no DOM), shared by the panel, the card and the tests.
import { itemEntities } from '../device-entities';
import type { EntityState, Hass } from '../ha-types';
import { DEFAULT_TX_DBM } from '../plan/constants';
import { isSignalSource } from '../plan/functions';
import type { Plan } from '../plan/models';
import type { Point } from '../plan/types';
import { HEAT_LAYERS, LAYERS, STALE_MS } from './constants';
import type { LayerData, LayerReading } from './models';
import type { HeatLayerId, RampStop } from './types';

/** The layer a sensor belongs to, from its device class (or, failing that, its unit). */
export function layerOfState(st: EntityState): HeatLayerId | null {
  const dc = st.attributes.device_class;
  const unit = st.attributes.unit_of_measurement;
  if (dc === 'temperature') return 'temperature';
  if (dc === 'humidity') return 'humidity';
  if (!dc && (unit === '°C' || unit === '°F')) return 'temperature';
  return null;
}

const toUnit = (v: number, from: string, to: string): number => {
  if (from === to) return v;
  const c = from === '°F' ? ((v - 32) * 5) / 9 : from === 'K' ? v - 273.15 : v;
  return to === '°F' ? (c * 9) / 5 + 32 : to === 'K' ? c + 273.15 : c;
};

interface LayerEntity {
  id: string;
  entity_id: string;
  position: Point;
  st: EntityState;
}

/**
 * The entity that feeds `layer` for each device item that has one (the first of its entities whose
 * class fits), by item id: a temperature and humidity sensor feeds both layers from one spot.
 */
function layerEntities(
  plan: Plan | null,
  hass: Hass | undefined,
  layer: HeatLayerId,
): LayerEntity[] {
  const items = itemEntities(plan, hass);
  const out: LayerEntity[] = [];
  for (const d of plan?.devices ?? []) {
    for (const entity_id of items.get(d.id) ?? []) {
      const st = hass?.states?.[entity_id];
      if (st && layerOfState(st) === layer) {
        out.push({ id: d.id, entity_id, position: d.position, st });
        break;
      }
    }
  }
  return out;
}

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
  for (const src of layerEntities(plan, hass, layer)) {
    const st = src.st;
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

/**
 * When the first of `data`'s readings goes stale (`last_reported` older than STALE_MS), in
 * `Date.now()` time; Infinity when none will (no time stamps, or the signal layer).
 */
export function staleAt(data: LayerData, hass: Hass | undefined, now = Date.now()): number {
  let at = Infinity;
  if (data.layer === 'signal') return at;
  for (const r of data.readings) {
    const reported = Date.parse(hass?.states?.[r.entity_id]?.last_reported ?? '');
    // A time stamp from the future (a clock ahead of the browser's) counts from now.
    if (Number.isFinite(reported)) at = Math.min(at, Math.min(reported, now) + STALE_MS);
  }
  return at;
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

/** A stable key for the sensor layout: re-triangulate only when it changes. */
export const layoutKey = (readings: readonly LayerReading[], outline: readonly Point[]): string =>
  readings.map((r) => `${r.id}@${r.position[0]},${r.position[1]}`).join(';') +
  '|' +
  outline.map((p) => p.join(',')).join(';');

/** Placed sensors and sources per layer (whatever their state), to enable the layer buttons. */
export function layerCounts(
  plan: Plan | null,
  hass: Hass | undefined,
): Record<HeatLayerId, number> {
  return {
    temperature: layerEntities(plan, hass, 'temperature').length,
    humidity: layerEntities(plan, hass, 'humidity').length,
    // Any device may be a mesh router (signal-mesh.ts): the map says when none is.
    signal: (plan?.sources ?? []).filter(isSignalSource).length + (plan?.devices?.length ?? 0),
  };
}

export const isHeatLayer = (v: unknown): v is HeatLayerId => HEAT_LAYERS.includes(v as HeatLayerId);
