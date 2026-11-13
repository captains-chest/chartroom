// The plan schema's version, built-in materials, defaults and per-floor limits.
import type { Material } from './models';

/**
 * Bump when a stored plan needs migrating; readers reject versions they don't know. The integration
 * rejects saves of any other version: bump PLAN_SCHEMA_VERSION in const.py with it.
 */
export const PLAN_SCHEMA_VERSION = 1;

/**
 * A plan's storage id, as the integration accepts it (PLAN_ID_RE in const.py): it is also its
 * underlay's file name. JavaScript's `$` without the `m` flag does not match before a newline.
 */
export const PLAN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** Built-in materials. A plan may add its own or override these by id. */
export const DEFAULT_MATERIALS: readonly Material[] = [
  { id: 'exterior', name: 'Exterior masonry / concrete', db_per_cm: 0.5 },
  { id: 'partition', name: 'Light partition', db_per_cm: 0.3 },
  { id: 'wood_door', name: 'Wooden door', db_per_cm: 0.75 },
  { id: 'glass', name: 'Glazing', db_per_cm: 1 },
];

/**
 * Limits per floor from docs/render-design.md, where the editor warns (it still saves). Above the
 * wall and device limits the plan may get slow on phones and wall tablets; access points and radios
 * are the signal map's hard limit (MAX_SIGNAL_SOURCES): it leaves out any beyond it.
 */
export const LIMITS = { walls: 512, accessPoints: 32, devices: 256 } as const;

/** Default reference level at 1 m for new access points and radios, in dBm. */
export const DEFAULT_TX_DBM = { access_point: -40, radio: -45 } as const;
