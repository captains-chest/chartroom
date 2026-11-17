// Editing operations on a plan. Every function is pure: it returns a new plan and leaves the input
// alone, so the editor can keep old plans on its undo stack.
import {
  add,
  closestOnSegment,
  cross,
  dist,
  frame,
  roundToMm,
  roundPointToMm,
  outlineFromWalls,
  polygonArea,
  same,
  sub,
} from '../geometry';
import { DEFAULT_TX_DBM, MAX_EXCLUDE } from './constants';
import { uniqueIds } from './functions';
import type { Device, Door, Material, Opening, Plan, Room, Source, Wall } from './models';
import type { OpeningKind, Point, SourceKind, Window } from './types';

/** What new walls, doors and windows start with (metres). */
const DEFAULT_WALL = { thickness: 0.1, material: 'partition' } as const;
const DEFAULT_DOOR = { width: 0.8, material: 'wood_door', thickness: 0.04 } as const;
const DEFAULT_WINDOW = { width: 1.2, material: 'glass', thickness: 0.024 } as const;
/** Walls shorter than this are not created. */
const MIN_WALL = 0.05;
/** Smallest wall thickness, opening width and opening thickness the inspector accepts (m). */
const MIN_WALL_THICKNESS = 0.01;
const MIN_OPENING_WIDTH = 0.1;
const MIN_OPENING_THICKNESS = 0.001;

/** `list` with the item `id` replaced by `change(item)`. */
const updateById = <T extends { id: string }>(
  list: readonly T[],
  id: string,
  change: (item: T) => T,
): T[] => list.map((x) => (x.id === id ? change(x) : x));

/** `list` without the item `id`. */
const withoutId = <T extends { id: string }>(list: readonly T[], id: string): T[] =>
  list.filter((x) => x.id !== id);

/** Doors and windows alike mapped through `change`. */
const mapOpenings = (plan: Plan, change: <T extends Opening>(o: T) => T): Plan => ({
  ...plan,
  doors: plan.doors.map(change),
  windows: plan.windows.map(change),
});

/** Doors and windows with the opening `id` replaced by `change(opening)`. */
const changeOpening = (plan: Plan, id: string, change: <T extends Opening>(o: T) => T): Plan =>
  mapOpenings(plan, (o) => (o.id === id ? change(o) : o));

/** A fresh id with the given prefix that the plan does not use yet. */
export function nextId(plan: Plan, prefix: string): string {
  const used = new Set<string>([
    ...plan.walls.map((x) => x.id),
    ...plan.rooms.map((x) => x.id),
    ...plan.doors.map((x) => x.id),
    ...plan.windows.map((x) => x.id),
    ...plan.sources.map((x) => x.id),
    ...(plan.devices ?? []).map((x) => x.id),
  ]);
  for (let i = 1; ; i++) {
    const id = `${prefix}_${i}`;
    if (!used.has(id)) return id;
  }
}

/** Recompute the outline from the walls (see outlineFromWalls). */
export function withOutline(plan: Plan): Plan {
  return { ...plan, outline: outlineFromWalls(plan) };
}

/** Keep every opening inside its wall after the wall changed length. */
function fitOpenings(plan: Plan): Plan {
  const lengths = new Map(plan.walls.map((w) => [w.id, frame(w).length]));
  const fit = <T extends Opening>(o: T): T => {
    const l = lengths.get(o.wall);
    if (l === undefined) return o;
    const width = roundToMm(Math.min(o.width, l));
    const offset = roundToMm(Math.max(0, Math.min(o.offset, l - width)));
    return width === o.width && offset === o.offset ? o : { ...o, width, offset };
  };
  return mapOpenings(plan, fit);
}

function finish(plan: Plan): Plan {
  return withOutline(fitOpenings(plan));
}

export function addWall(
  plan: Plan,
  a: Point,
  b: Point,
  props: Partial<Pick<Wall, 'thickness' | 'material'>> = {},
): { plan: Plan; id: string | null } {
  if (dist(a, b) < MIN_WALL) return { plan, id: null };
  const id = nextId(plan, 'wall');
  const wall: Wall = {
    id,
    a: roundPointToMm(a),
    b: roundPointToMm(b),
    thickness: props.thickness ?? DEFAULT_WALL.thickness,
    material: props.material ?? DEFAULT_WALL.material,
  };
  return { plan: finish({ ...plan, walls: [...plan.walls, wall] }), id };
}

/**
 * Move every wall endpoint at `from` to `to`, so walls joined at a corner stay joined.
 * Walls that would collapse to (almost) nothing keep their old endpoint.
 */
export function moveEndpoint(plan: Plan, from: Point, to: Point): Plan {
  const target = roundPointToMm(to);
  const walls = plan.walls.map((w) => {
    const a = same(w.a, from) ? target : w.a;
    const b = same(w.b, from) ? target : w.b;
    if (a === w.a && b === w.b) return w;
    return dist(a, b) < MIN_WALL ? w : { ...w, a, b };
  });
  return finish({ ...plan, walls });
}

/** Move a whole wall by `delta`; walls joined to either end stretch to follow it. */
export function moveWall(plan: Plan, id: string, delta: Point): Plan {
  const wall = plan.walls.find((w) => w.id === id);
  if (!wall) return plan;
  const a = roundPointToMm(add(wall.a, delta));
  const b = roundPointToMm(add(wall.b, delta));
  const walls = plan.walls.map((w) => {
    if (w.id === id) return { ...w, a, b };
    let next = w;
    if (same(w.a, wall.a)) next = { ...next, a };
    else if (same(w.a, wall.b)) next = { ...next, a: b };
    if (same(w.b, wall.a)) next = { ...next, b: a };
    else if (same(w.b, wall.b)) next = { ...next, b };
    return next;
  });
  return finish({ ...plan, walls });
}

export function updateWall(plan: Plan, id: string, patch: Partial<Omit<Wall, 'id'>>): Plan {
  const clean: Partial<Wall> = { ...patch };
  if (clean.thickness !== undefined)
    clean.thickness = roundToMm(Math.max(MIN_WALL_THICKNESS, clean.thickness));
  return finish({ ...plan, walls: updateById(plan.walls, id, (w) => ({ ...w, ...clean })) });
}

/** Delete a wall and the doors and windows in it. */
export function deleteWall(plan: Plan, id: string): Plan {
  return finish({
    ...plan,
    walls: withoutId(plan.walls, id),
    doors: plan.doors.filter((d) => d.wall !== id),
    windows: plan.windows.filter((w) => w.wall !== id),
  });
}

/** The wall nearest to `p` within `tolerance` (measured to its face, not its centre line). */
export function wallAt(
  plan: Plan,
  p: Point,
  tolerance: number,
): { wall: Wall; along: number } | null {
  let best: { wall: Wall; along: number; d: number } | null = null;
  for (const wall of plan.walls) {
    const c = closestOnSegment(wall.a, wall.b, p);
    const d = c.d - wall.thickness / 2;
    if (d <= tolerance && (!best || d < best.d)) {
      best = { wall, along: c.t * frame(wall).length, d };
    }
  }
  return best ? { wall: best.wall, along: best.along } : null;
}

/** Put a door or window centred at `centre` metres along the wall. */
export function addOpening(
  plan: Plan,
  kind: OpeningKind,
  wallId: string,
  centre: number,
  p?: Point,
): { plan: Plan; id: string | null } {
  const wall = plan.walls.find((w) => w.id === wallId);
  if (!wall) return { plan, id: null };
  const l = frame(wall).length;
  const d = kind === 'door' ? DEFAULT_DOOR : DEFAULT_WINDOW;
  const width = roundToMm(Math.min(d.width, l));
  const offset = roundToMm(Math.max(0, Math.min(centre - width / 2, l - width)));
  const id = nextId(plan, kind);
  const base = { id, wall: wallId, offset, width, material: d.material, thickness: d.thickness };
  if (kind === 'door') {
    // Swing towards the side of the click, if there was one.
    const side = p ? Math.sign(cross(sub(wall.b, wall.a), sub(p, wall.a))) : 1;
    const door: Door = { ...base, hinge: 'a', swing: side < 0 ? -1 : 1 };
    return { plan: { ...plan, doors: [...plan.doors, door] }, id };
  }
  const win: Window = base;
  return { plan: { ...plan, windows: [...plan.windows, win] }, id };
}

/** Slide an opening so its centre sits `centre` metres along its wall. */
export function moveOpening(plan: Plan, id: string, centre: number): Plan {
  const lengths = new Map(plan.walls.map((w) => [w.id, frame(w).length]));
  return changeOpening(plan, id, (o) => {
    const l = lengths.get(o.wall) ?? o.width;
    return { ...o, offset: roundToMm(Math.max(0, Math.min(centre - o.width / 2, l - o.width))) };
  });
}

export function updateOpening(
  plan: Plan,
  id: string,
  patch: Partial<Omit<Door, 'id' | 'wall'>>,
): Plan {
  return fitOpenings(
    changeOpening(plan, id, (o) => {
      const next = { ...o, ...patch };
      if (patch.width !== undefined) {
        // Keep the centre where it was.
        next.width = roundToMm(Math.max(MIN_OPENING_WIDTH, patch.width));
        next.offset = roundToMm(o.offset + (o.width - next.width) / 2);
      }
      if (patch.thickness !== undefined)
        next.thickness = roundToMm(Math.max(MIN_OPENING_THICKNESS, patch.thickness));
      return next;
    }),
  );
}

export function deleteOpening(plan: Plan, id: string): Plan {
  return { ...plan, doors: withoutId(plan.doors, id), windows: withoutId(plan.windows, id) };
}

export function addRoom(
  plan: Plan,
  polygon: readonly Point[],
  name?: string,
): { plan: Plan; id: string | null } {
  if (polygon.length < 3) return { plan, id: null };
  const id = nextId(plan, 'room');
  const room: Room = {
    id,
    name: name ?? `Room ${plan.rooms.length + 1}`,
    polygon: polygon.map(roundPointToMm),
  };
  return { plan: { ...plan, rooms: [...plan.rooms, room] }, id };
}

export function updateRoom(plan: Plan, id: string, patch: Partial<Omit<Room, 'id'>>): Plan {
  return {
    ...plan,
    rooms: updateById(plan.rooms, id, (r) => {
      const next: Room = { ...r, ...patch };
      if ('area_ids' in patch) {
        const ids = uniqueIds(patch.area_ids ?? []);
        if (ids.length > 0) next.area_ids = ids;
        else delete next.area_ids;
      }
      return next;
    }),
  };
}

export function moveRoomVertex(plan: Plan, id: string, index: number, to: Point): Plan {
  return {
    ...plan,
    rooms: updateById(plan.rooms, id, (r) => ({
      ...r,
      polygon: r.polygon.map((p, i) => (i === index ? roundPointToMm(to) : p)),
    })),
  };
}

export function deleteRoom(plan: Plan, id: string): Plan {
  return { ...plan, rooms: withoutId(plan.rooms, id) };
}

/**
 * Scale the drawing about the origin, for calibration: positions, opening sizes and the underlay
 * grow by `k`; wall and opening thicknesses are real sizes and stay as they are.
 */
export function scalePlan(plan: Plan, k: number): Plan {
  if (!(k > 0) || !Number.isFinite(k)) throw new Error('scale factor must be positive');
  const s = (p: Point): Point => roundPointToMm([p[0] * k, p[1] * k]);
  const op = <T extends Opening>(o: T): T => ({
    ...o,
    offset: roundToMm(o.offset * k),
    width: roundToMm(o.width * k),
  });
  return withOutline(
    mapOpenings(
      {
        ...plan,
        walls: plan.walls.map((w) => ({ ...w, a: s(w.a), b: s(w.b) })),
        rooms: plan.rooms.map((r) => ({ ...r, polygon: r.polygon.map(s) })),
        sources: plan.sources.map((x) => ({ ...x, position: s(x.position) })),
        ...(plan.devices
          ? { devices: plan.devices.map((x) => ({ ...x, position: s(x.position) })) }
          : {}),
        underlay: plan.underlay
          ? { ...plan.underlay, scale: plan.underlay.scale * k, origin: s(plan.underlay.origin) }
          : plan.underlay,
      },
      op,
    ),
  );
}

/** Scale factor that makes the distance between two drawn points equal `metres`. */
export function twoPointFactor(p: Point, q: Point, metres: number): number {
  const d = dist(p, q);
  if (d <= 0 || !(metres > 0)) throw new Error('need two distinct points and a positive distance');
  return metres / d;
}

/** Scale factor that makes a drawn polygon's area equal `squareMetres`. */
export function areaFactor(polygon: readonly Point[], squareMetres: number): number {
  const a = polygonArea(polygon);
  if (a <= 0 || !(squareMetres > 0))
    throw new Error('need a room with an area and a positive target');
  return Math.sqrt(squareMetres / a);
}

/** Move a whole room by `delta`. */
export function moveRoom(plan: Plan, id: string, delta: Point): Plan {
  return {
    ...plan,
    rooms: updateById(plan.rooms, id, (r) => ({
      ...r,
      polygon: r.polygon.map((p) => roundPointToMm(add(p, delta))),
    })),
  };
}

/** Add or override a material in the plan's own table. */
export function setMaterial(plan: Plan, material: Material): Plan {
  return {
    ...plan,
    materials: [
      ...withoutId(plan.materials ?? [], material.id),
      { ...material, db_per_cm: Math.max(0, material.db_per_cm) },
    ],
  };
}

/** Place an access point or radio, with the default reference level. */
export function addSource(
  plan: Plan,
  kind: SourceKind,
  position: Point,
  entity_id = '',
  area_id: string | null = null,
): { plan: Plan; id: string } {
  const id = nextId(plan, kind);
  const source: Source = { id, kind, entity_id, position: roundPointToMm(position) };
  if (area_id) source.area_id = area_id;
  source.tx_dbm = DEFAULT_TX_DBM[kind];
  return { plan: { ...plan, sources: [...plan.sources, source] }, id };
}

export function moveSource(plan: Plan, id: string, to: Point): Plan {
  return {
    ...plan,
    sources: updateById(plan.sources, id, (x) => ({ ...x, position: roundPointToMm(to) })),
  };
}

/** Change a source. One without a reference level gets the default. */
export function updateSource(plan: Plan, id: string, patch: Partial<Omit<Source, 'id'>>): Plan {
  return {
    ...plan,
    sources: updateById(plan.sources, id, (x) => {
      const next: Source = { ...x, ...patch };
      if (next.tx_dbm === undefined) next.tx_dbm = DEFAULT_TX_DBM[next.kind];
      if (!next.area_id) delete next.area_id;
      return next;
    }),
  };
}

export function deleteSource(plan: Plan, id: string): Plan {
  return { ...plan, sources: withoutId(plan.sources, id) };
}

// ---- devices ----

/**
 * Place a Home Assistant device (by `entity_id`, the entity its marker shows), or an entity without
 * one, as a device marker. One already on the plan is moved instead.
 */
export function addDevice(
  plan: Plan,
  entity_id: string,
  position: Point,
  device_id: string | null = null,
): { plan: Plan; id: string } {
  const devices = plan.devices ?? [];
  const existing = devices.find((d) =>
    device_id ? d.device_id === device_id : d.entity_id === entity_id,
  );
  if (existing) return { plan: moveDevice(plan, existing.id, position), id: existing.id };
  const id = nextId(plan, 'device');
  const device: Device = { id, entity_id, position: roundPointToMm(position) };
  if (device_id) device.device_id = device_id;
  return { plan: { ...plan, devices: [...devices, device] }, id };
}

export function moveDevice(plan: Plan, id: string, to: Point): Plan {
  return {
    ...plan,
    devices: updateById(plan.devices ?? [], id, (d) => ({ ...d, position: roundPointToMm(to) })),
  };
}

/** Show another device (or entity without one) at the item's place, leaving none of it out. */
export function updateDevice(
  plan: Plan,
  id: string,
  entity_id: string,
  device_id: string | null = null,
): Plan {
  return {
    ...plan,
    devices: updateById(plan.devices ?? [], id, ({ device_id: _old, exclude: _out, ...d }) =>
      device_id ? { ...d, entity_id, device_id } : { ...d, entity_id },
    ),
  };
}

/** Leave these entities of the item's device out of it (never its own `entity_id`). */
export function setDeviceExclude(plan: Plan, id: string, exclude: readonly string[]): Plan {
  return {
    ...plan,
    devices: updateById(plan.devices ?? [], id, ({ exclude: _old, ...d }) => {
      const ids = uniqueIds(exclude)
        .filter((e) => e !== d.entity_id)
        .slice(0, MAX_EXCLUDE);
      return ids.length > 0 ? { ...d, exclude: ids } : d;
    }),
  };
}

export function deleteDevice(plan: Plan, id: string): Plan {
  return { ...plan, devices: withoutId(plan.devices ?? [], id) };
}
