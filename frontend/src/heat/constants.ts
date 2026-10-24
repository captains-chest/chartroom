// The heat layers with their ramps and ranges, and the timings and no-data look shared by the
// renderers.
import type { LayerSpec } from './models';
import type { HeatLayerId } from './types';

export const HEAT_LAYERS: readonly HeatLayerId[] = ['temperature', 'humidity', 'signal'];

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

/** Readings older than this (by `last_reported`, when Home Assistant sends it) are stale. */
export const STALE_MS = 6 * 3600_000;

/** Transition length for value and layout changes, in ms (docs/render-design.md). */
export const TRANSITION_MS = 600;

/** How cells without data look: a grey level (0..1) and its strength relative to the field. */
export const NO_DATA_GREY = 0.55;
export const NO_DATA_ALPHA = 0.35;
