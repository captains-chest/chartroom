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

/** Our own line glyphs on a 24-unit grid (no icon library). */
export const GLYPHS: Record<Glyph, string> = {
  light: 'M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3zM9.5 19h5M10.5 21.5h3',
  switch: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7zM16 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  fan: 'M12 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3zM12 10.5C11 6 12 3 15 3.5s1 5-3 7zM13.5 12.5c4.5-1 7.5 0 7 3s-5 1-7-3zM10.5 12.5c-3 3.5-6 4.5-7.5 2s2.5-4.5 7.5-2z',
  toggle: 'M5 5h14v14H5zM9 12l2 2 4-4',
  cover: 'M4 4h16M6 4v12h12V4M6 8h12M6 12h12M12 16v4',
  lock: 'M8 11V8a4 4 0 0 1 8 0v3M6 11h12v10H6zM12 15v2',
  door: 'M6 21V3h12v18M3 21h18M14.5 12h.5',
  window: 'M5 4h14v16H5zM12 4v16M5 12h14',
  garage: 'M3 21V9l9-5 9 5v12M7 21v-9h10v9M7 15h10M7 18h10',
  motion:
    'M13.5 3.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3zM9 21l2.5-6 2.5 2.5V21M7 12l3-3.5 3.5 1.5 2 3h2.5M11.5 15l1-6',
  thermometer: 'M10 13.5V5a2 2 0 0 1 4 0v8.5a4 4 0 1 1-4 0zM12 9v7',
  humidity: 'M12 3.5s-6 6.5-6 10.5a6 6 0 0 0 12 0c0-4-6-10.5-6-10.5z',
  sensor: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
};

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

/**
 * What clicking or tapping a marker does, by the entity it shows: what the device is there to
 * control acts (a light, switch, fan or input boolean toggles, a cover opens, closes or stops, a
 * lock asks, then locks or unlocks); anything else opens the device's wheel, where each of its
 * readings is (no one sensor is the click).
 */
export type TapAction =
  | { type: 'service'; domain: string; service: string; confirm?: string }
  | { type: 'menu' };

export function tapAction(entityId: string, st: EntityState | undefined): TapAction {
  const domain = domainOf(entityId);
  const state = st?.state;
  const name = st?.attributes.friendly_name ?? entityId;
  if (!state || state === 'unavailable' || state === 'unknown') return { type: 'menu' };
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
      return { type: 'menu' };
    default:
      return { type: 'menu' };
  }
}

/** "Set preset mode" for "set_preset_mode": words, capitalised. */
export const words = (s: string): string => {
  const t = s.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The name of Home Assistant device `deviceId`, else of the entity its marker shows. */
export function deviceName(
  primary: string,
  deviceId: string | null | undefined,
  hass: Hass | undefined,
): string {
  const dev = deviceId ? hass?.devices?.[deviceId] : undefined;
  return (
    dev?.name_by_user || dev?.name || hass?.states?.[primary]?.attributes.friendly_name || primary
  );
}

/** An entity's name without its device's ("Temperature" of "Kitchen sensor Temperature"). */
export function entityName(entity: string, device: string, hass: Hass | undefined): string {
  const st = hass?.states?.[entity];
  const full = st?.attributes.friendly_name ?? entity;
  const own = full.toLowerCase().startsWith(device.toLowerCase())
    ? full.slice(device.length).trim()
    : full;
  return words(own || st?.attributes.device_class || domainOf(entity));
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
