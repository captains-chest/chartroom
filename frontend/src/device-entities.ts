// Which Home Assistant entities a placed device item stands for, which one its marker shows, and
// folding items of one device placed apart (plans from before items named devices) into one. Pure
// functions over the plan and the entity registry, cached per plan and registry object.
import { dist, roundPointToMm } from './geometry';
import type { EntityEntry, Hass } from './ha-types';
import type { Device, Plan } from './plan/models';
import type { Point } from './plan/types';

/** Domains whose marker does something on a tap. */
const CONTROLS = new Set(['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock']);

/** Domains that can go on the plan as device markers (sensors only as temperature or humidity). */
export const DEVICE_DOMAINS = [...CONTROLS, 'binary_sensor'] as const;

/** Sensor classes a device is placed for: the heatmap layers'. */
export const SENSOR_CLASSES: readonly string[] = ['temperature', 'humidity'];

const domainOf = (entityId: string): string => entityId.slice(0, entityId.indexOf('.'));

/** Whether an entity's state is worth a marker on its own (a device is placed for it). */
export function isPlaceable(entityId: string, hass: Hass | undefined): boolean {
  const domain = domainOf(entityId);
  if (domain === 'sensor')
    return SENSOR_CLASSES.includes(hass?.states?.[entityId]?.attributes.device_class ?? '');
  return CONTROLS.has(domain) || domain === 'binary_sensor';
}

const indexes = new WeakMap<Record<string, EntityEntry>, Map<string, string[]>>();

/** Each device's entities by device id, without hidden and config/diagnostic ones, sorted. */
function deviceIndex(entities: Record<string, EntityEntry>): Map<string, string[]> {
  let index = indexes.get(entities);
  if (!index) {
    index = new Map();
    for (const e of Object.values(entities)) {
      if (!e.device_id || e.hidden || e.entity_category) continue;
      const list = index.get(e.device_id);
      if (list) list.push(e.entity_id);
      else index.set(e.device_id, [e.entity_id]);
    }
    for (const list of index.values()) list.sort();
    indexes.set(entities, index);
  }
  return index;
}

/** A Home Assistant device's entities, without hidden and config/diagnostic ones. */
export const entitiesOfDevice = (hass: Hass | undefined, deviceId: string): readonly string[] =>
  (hass?.entities && deviceIndex(hass.entities).get(deviceId)) || [];

const resolved = new WeakMap<
  Plan,
  { entities: Hass['entities']; map: Map<string, readonly string[]> }
>();

/**
 * Each device item's entities by item id: its own `entity_id` first, then the rest of its device's.
 * An entity placed as an item of its own (a sensor of the device placed apart) is left to that item.
 */
export function itemEntities(
  plan: Plan | null,
  hass: Hass | undefined,
): ReadonlyMap<string, readonly string[]> {
  if (!plan) return new Map();
  const cached = resolved.get(plan);
  if (cached && cached.entities === hass?.entities) return cached.map;
  const devices = plan.devices ?? [];
  const own = new Set(devices.filter((d) => !d.device_id).map((d) => d.entity_id));
  const map = new Map<string, readonly string[]>();
  for (const d of devices) {
    const rest = d.device_id
      ? entitiesOfDevice(hass, d.device_id).filter((e) => e !== d.entity_id && !own.has(e))
      : [];
    map.set(d.id, [d.entity_id, ...rest]);
  }
  resolved.set(plan, { entities: hass?.entities, map });
  return map;
}

/** How well an entity speaks for its device: lower is better. */
function rank(entityId: string, hass: Hass | undefined): number {
  const domain = domainOf(entityId);
  if (CONTROLS.has(domain)) return 0;
  if (domain === 'binary_sensor') return 1;
  if (domain === 'sensor') {
    const i = SENSOR_CLASSES.indexOf(hass?.states?.[entityId]?.attributes.device_class ?? '');
    return i < 0 ? 2 + SENSOR_CLASSES.length : 2 + i;
  }
  return 9;
}

/**
 * The entity a device's marker shows and a tap acts on: the one it can control, else a binary
 * sensor, else a temperature, then humidity, then other sensor; the first in `ids` among equals.
 */
export function primaryEntity(ids: readonly string[], hass: Hass | undefined): string {
  let best = ids[0] ?? '';
  let bestRank = Infinity;
  for (const id of ids) {
    const r = rank(id, hass);
    if (r < bestRank) [best, bestRank] = [id, r];
  }
  return best;
}

/** The entity a placed item's marker shows. */
export const itemPrimary = (plan: Plan, hass: Hass | undefined, d: Device): string =>
  primaryEntity(itemEntities(plan, hass).get(d.id) ?? [d.entity_id], hass);

/** Items of one device this close together (metres) fold into one. */
export const FOLD_M = 1;

/**
 * `plan` with its items that name an entity of a Home Assistant device, but not the device (plans
 * from before items named devices: each sensor of a multisensor placed on its own), naming the
 * device; items of one device near each other become one, at their middle. One near an item that
 * already names the device folds into it. One far from the others of its device stays on its own.
 * The same plan when nothing changes (no registry yet, or nothing to fold).
 */
export function foldDevices(plan: Plan, hass: Hass | undefined): Plan {
  const entities = hass?.entities;
  if (!entities || !plan.devices?.length) return plan;
  const cached = folds.get(plan);
  if (cached?.entities === entities) return cached.plan;
  const folded = fold(plan, plan.devices, entities);
  folds.set(plan, { entities, plan: folded });
  return folded;
}

const folds = new WeakMap<Plan, { entities: Record<string, EntityEntry>; plan: Plan }>();

function fold(plan: Plan, devices: readonly Device[], entities: Record<string, EntityEntry>): Plan {
  const deviceOf = (d: Device): string | null =>
    d.device_id ? null : (entities[d.entity_id]?.device_id ?? null);
  if (!devices.some(deviceOf)) return plan;
  const named = devices.filter((d) => d.device_id);
  /** Items made here, with the positions folded into each. */
  const made = new Map<Device, Point[]>();
  const out: Device[] = [];
  let changed = false;
  for (const d of devices) {
    const dev = deviceOf(d);
    if (!dev) {
      out.push(d);
      continue;
    }
    const near = (o: Device): boolean =>
      o.device_id === dev && dist(o.position, d.position) <= FOLD_M;
    if (named.some(near)) {
      changed = true;
      continue;
    }
    const into = [...made.keys()].find(near);
    if (into) {
      const at = [...made.get(into)!, d.position];
      const mid = roundPointToMm([
        at.reduce((s, p) => s + p[0], 0) / at.length,
        at.reduce((s, p) => s + p[1], 0) / at.length,
      ]);
      const next = { ...into, position: mid };
      made.delete(into);
      made.set(next, at);
      out[out.indexOf(into)] = next;
      changed = true;
    } else if ([...named, ...made.keys()].some((o) => o.device_id === dev)) {
      out.push(d);
    } else {
      const next = { ...d, device_id: dev };
      made.set(next, [d.position]);
      out.push(next);
      changed = true;
    }
  }
  return changed ? { ...plan, devices: out } : plan;
}

/**
 * The entities a plan reads: its devices' (the sensors and what a marker can show), its sources'
 * and its doors' and windows' (open or closed). Sensors come first, apart, so history can fetch
 * them as statistics.
 */
export function planEntities(
  plan: Plan | null,
  hass: Hass | undefined,
): { sensors: string[]; others: string[] } {
  const sensors = new Set<string>();
  const others = new Set<string>();
  const items = itemEntities(plan, hass);
  for (const d of plan?.devices ?? []) {
    for (const id of items.get(d.id) ?? [d.entity_id]) {
      const domain = domainOf(id);
      if (domain === 'sensor') sensors.add(id);
      else if (id === d.entity_id || CONTROLS.has(domain) || domain === 'binary_sensor')
        others.add(id);
    }
  }
  for (const s of plan?.sources ?? []) if (s.entity_id) others.add(s.entity_id);
  for (const o of [...(plan?.doors ?? []), ...(plan?.windows ?? [])])
    if (o.entity_id) others.add(o.entity_id);
  for (const id of sensors) others.delete(id);
  return { sensors: [...sensors], others: [...others] };
}
