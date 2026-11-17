// Device markers: what state an entity is in, what tapping it does, which devices can go on a
// plan and where auto-placement puts them. Pure functions, shared by the panel, card and editor.
import { entitiesOfDevice, isPlaceable, primaryEntity } from './device-entities';
import { pointInPolygon, polygonArea, polygonCentroid } from './geometry';
import type { EntityState, Hass } from './ha-types';
import { entityArea } from './model';
import type { Device, Plan } from './plan/models';
import type { Point } from './plan/types';
import { labelPoint } from './plan-svg';

export { DEVICE_DOMAINS } from './device-entities';

/** binary_sensor and cover classes that read as open / closed rather than on / off. */
const OPENINGS = new Set(['door', 'window', 'garage_door', 'opening', 'gate', 'garage']);

export type Status =
  | 'on'
  | 'off'
  | 'open'
  | 'closed'
  | 'opening'
  | 'closing'
  | 'locked'
  | 'unlocked'
  /** A sensor's value. */
  | 'reading'
  | 'unavailable'
  | 'unknown';

/** Which glyph a marker draws. */
export type Glyph =
  | 'light'
  | 'switch'
  | 'plug'
  | 'fan'
  | 'toggle'
  | 'cover'
  | 'lock'
  | 'door'
  | 'window'
  | 'garage'
  | 'motion'
  | 'thermometer'
  | 'humidity'
  | 'sensor';

export interface DeviceLook {
  status: Status;
  /** On, open, unlocked, detected: drawn filled in the domain's colour. */
  active: boolean;
  glyph: Glyph;
  /** "open", "21.4 °C", "unavailable": the state in words, with its unit. */
  value: string;
  /** "Front door: open" — the marker's accessible name. */
  label: string;
}

const domainOf = (entityId: string): string => entityId.slice(0, entityId.indexOf('.'));

export function glyphOf(entityId: string, st: EntityState | undefined): Glyph {
  const cls = st?.attributes.device_class ?? '';
  switch (domainOf(entityId)) {
    case 'light':
      return 'light';
    case 'switch':
      return cls === 'outlet' ? 'plug' : 'switch';
    case 'fan':
      return 'fan';
    case 'input_boolean':
      return 'toggle';
    case 'lock':
      return 'lock';
    case 'cover':
      return cls === 'garage' || cls === 'gate' ? 'garage' : cls === 'door' ? 'door' : 'cover';
    case 'binary_sensor':
      if (cls === 'door' || cls === 'opening') return 'door';
      if (cls === 'window') return 'window';
      if (cls === 'garage_door') return 'garage';
      if (cls === 'lock') return 'lock';
      if (cls === 'motion' || cls === 'occupancy' || cls === 'presence') return 'motion';
      return 'sensor';
    case 'sensor':
      return cls === 'temperature' ? 'thermometer' : cls === 'humidity' ? 'humidity' : 'sensor';
    default:
      return 'sensor';
  }
}

const WORDS: Partial<Record<Status, string>> = { unavailable: 'unavailable', unknown: 'unknown' };

/** The marker for an entity's current state (`st` undefined: the entity is gone). */
export function deviceLook(entityId: string, st: EntityState | undefined): DeviceLook {
  const glyph = glyphOf(entityId, st);
  const name = st?.attributes.friendly_name ?? entityId;
  const domain = domainOf(entityId);
  const cls = st?.attributes.device_class ?? '';
  const raw = st?.state ?? 'unavailable';
  const unit = st?.attributes.unit_of_measurement;
  const reading = unit ? `${raw} ${unit}` : raw;
  let status: Status;
  let active = false;
  let word: string | undefined;
  if (raw === 'unavailable' || raw === 'unknown') {
    status = raw;
  } else if (domain === 'cover') {
    status =
      (['open', 'closed', 'opening', 'closing'] as const).find((x) => x === raw) ?? 'unknown';
    active = status !== 'closed' && status !== 'unknown';
  } else if (domain === 'lock') {
    // locking / unlocking / jammed / open count as not locked.
    status =
      raw === 'locked' ? 'locked' : raw === 'unlocked' || raw === 'open' ? 'unlocked' : 'unknown';
    active = status === 'unlocked';
    if (status === 'unknown') word = raw;
  } else if (domain === 'sensor') {
    status = 'reading';
    word = reading;
  } else if (raw === 'on' || raw === 'off') {
    active = raw === 'on';
    if (domain === 'binary_sensor' && cls === 'lock') {
      status = active ? 'unlocked' : 'locked';
    } else if (domain === 'binary_sensor' && OPENINGS.has(cls)) {
      status = active ? 'open' : 'closed';
    } else {
      status = raw;
      if (glyph === 'motion') word = active ? 'detected' : 'clear';
    }
  } else {
    status = 'unknown';
    word = reading;
  }
  const value = word ?? WORDS[status] ?? status;
  return { status, active, glyph, value, label: `${name}: ${value}` };
}

/** What tapping a marker does: call a service (maybe after confirming), or show details. */
export type TapAction =
  | { type: 'service'; domain: string; service: string; confirm?: string }
  | { type: 'more-info' };

export function tapAction(entityId: string, st: EntityState | undefined): TapAction {
  const domain = domainOf(entityId);
  const state = st?.state;
  const name = st?.attributes.friendly_name ?? entityId;
  if (!state || state === 'unavailable' || state === 'unknown') return { type: 'more-info' };
  switch (domain) {
    case 'light':
    case 'switch':
    case 'fan':
    case 'input_boolean':
      return { type: 'service', domain, service: 'toggle' };
    case 'cover':
      if (state === 'opening' || state === 'closing')
        return { type: 'service', domain, service: 'stop_cover' };
      return {
        type: 'service',
        domain,
        service: state === 'closed' ? 'open_cover' : 'close_cover',
      };
    case 'lock':
      if (state === 'locked')
        return { type: 'service', domain, service: 'unlock', confirm: `Unlock ${name}?` };
      if (state === 'unlocked' || state === 'open')
        return { type: 'service', domain, service: 'lock', confirm: `Lock ${name}?` };
      return { type: 'more-info' };
    default:
      return { type: 'more-info' };
  }
}

export interface DeviceChoice {
  /** The entity its marker shows (primaryEntity); the item is placed by it. */
  entity_id: string;
  /** The Home Assistant device, or null for an entity without one (a helper, a template sensor). */
  device_id: string | null;
  name: string;
  area_id: string | null;
}

/**
 * What can be placed on a plan: Home Assistant devices with an entity worth a marker (a light,
 * switch, fan, cover, lock, binary sensor, or a temperature or humidity sensor; not hidden or
 * config/diagnostic), and such entities that have no device. On a plan with a floor, only those
 * in that floor's areas.
 */
export function deviceChoices(hass: Hass | undefined, floorId: string | null): DeviceChoice[] {
  const areas = hass?.areas ?? {};
  const out: DeviceChoice[] = [];
  const seen = new Set<string>();
  for (const st of Object.values(hass?.states ?? {})) {
    const reg = hass?.entities?.[st.entity_id];
    if (reg?.hidden || reg?.entity_category || !isPlaceable(st.entity_id, hass)) continue;
    const device_id = reg?.device_id || null;
    if (device_id && seen.has(device_id)) continue;
    if (device_id) seen.add(device_id);
    const entity_id = device_id
      ? primaryEntity(
          entitiesOfDevice(hass, device_id).filter((e) => isPlaceable(e, hass)),
          hass,
        )
      : st.entity_id;
    const area = entityArea(hass, entity_id);
    if (floorId && (area === null || areas[area]?.floor_id !== floorId)) continue;
    const dev = device_id ? hass?.devices?.[device_id] : undefined;
    out.push({
      entity_id,
      device_id,
      name:
        dev?.name_by_user ||
        dev?.name ||
        hass?.states?.[entity_id]?.attributes.friendly_name ||
        entity_id,
      area_id: area,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.entity_id.localeCompare(b.entity_id));
}

/** Whether `choice` is on the plan already: its device, or (without one) its entity. */
export const isPlaced = (devices: readonly Device[], choice: DeviceChoice): boolean =>
  devices.some((d) =>
    choice.device_id ? d.device_id === choice.device_id : d.entity_id === choice.entity_id,
  );

/** Spacing between auto-placed markers, in metres. */
const GAP = 0.45;

/**
 * Spots for `n` markers in a room: a spiral of grid points out from the centroid, inside the
 * room and clear of `taken` spots. Falls back to the centroid when the room is too small.
 */
export function spotsInRoom(
  polygon: readonly Point[],
  n: number,
  taken: readonly Point[],
  label?: Point,
): Point[] {
  // Start below the room's name and area, and keep off them.
  const below: Point | null = label ? [label[0], label[1] + 1.1] : null;
  const c = below && pointInPolygon(below, polygon) ? below : polygonCentroid(polygon);
  const out: Point[] = [];
  const onLabel = (p: Point): boolean =>
    !!label && Math.abs(p[0] - label[0]) < 1.4 && Math.abs(p[1] - label[1]) < 0.6;
  const clear = (p: Point): boolean =>
    !onLabel(p) &&
    [...taken, ...out].every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= GAP * 0.9);
  for (let ring = 0; out.length < n && ring < 12; ring++) {
    for (let dy = -ring; dy <= ring && out.length < n; dy++) {
      for (let dx = -ring; dx <= ring && out.length < n; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p: Point = [round(c[0] + dx * GAP), round(c[1] + dy * GAP)];
        if (pointInPolygon(p, polygon) && clear(p)) out.push(p);
      }
    }
  }
  while (out.length < n) out.push([round(c[0]), round(c[1])]);
  return out;
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Where auto-placement puts each device not on the plan yet: in the room linked to its area (a room
 * can link several). Devices whose area has no room are left out.
 */
export function autoPlace(
  plan: Plan,
  choices: readonly DeviceChoice[],
): { choice: DeviceChoice; position: Point }[] {
  const devices = plan.devices ?? [];
  const taken: Point[] = [
    ...(plan.devices ?? []).map((d) => d.position),
    ...plan.sources.map((s) => s.position),
  ];
  const out: { choice: DeviceChoice; position: Point }[] = [];
  const byArea = new Map<string, DeviceChoice[]>();
  for (const c of choices) {
    if (isPlaced(devices, c) || !c.area_id) continue;
    byArea.set(c.area_id, [...(byArea.get(c.area_id) ?? []), c]);
  }
  for (const [area, list] of byArea) {
    // The largest room linked to the area takes its devices.
    const room = plan.rooms
      .filter((r) => r.area_ids?.includes(area) && r.polygon.length >= 3)
      .sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0];
    if (!room) continue;
    const spots = spotsInRoom(room.polygon, list.length, taken, labelPoint(room));
    list.forEach((c, i) => {
      out.push({ choice: c, position: spots[i]! });
      taken.push(spots[i]!);
    });
  }
  return out;
}
