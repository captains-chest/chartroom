// Editing operations on a plan. Every function is pure: it returns a new plan and leaves the input
// alone, so the editor can keep old plans on its undo stack.
import {
  add,
  closestOnSegment,
  dist,
  frame,
  mm,
  mmPoint,
  outlineFromWalls,
  same,
  sub,
  wallRect,
} from './geometry';
import type {
  Door,
  Material,
  Opening,
  Plan,
  Point,
  Room,
  Source,
  SourceKind,
  Wall,
  Window,
} from './plan';
import { DEFAULT_TX_DBM } from './plan';

export type OpeningKind = 'door' | 'window';

export const DEFAULT_WALL = { thickness: 0.1, material: 'partition' } as const;
export const DEFAULT_DOOR = { width: 0.8, material: 'wood_door', thickness: 0.04 } as const;
export const DEFAULT_WINDOW = { width: 1.2, material: 'glass', thickness: 0.024 } as const;
/** Walls shorter than this are not created. */
export const MIN_WALL = 0.05;

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
    const width = mm(Math.min(o.width, l));
    const offset = mm(Math.max(0, Math.min(o.offset, l - width)));
    return width === o.width && offset === o.offset ? o : { ...o, width, offset };
  };
  return { ...plan, doors: plan.doors.map(fit), windows: plan.windows.map(fit) };
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
    a: mmPoint(a),
    b: mmPoint(b),
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
  const target = mmPoint(to);
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
  const a = mmPoint(add(wall.a, delta));
  const b = mmPoint(add(wall.b, delta));
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
  if (clean.thickness !== undefined) clean.thickness = mm(Math.max(0.01, clean.thickness));
  return finish({ ...plan, walls: plan.walls.map((w) => (w.id === id ? { ...w, ...clean } : w)) });
}

/** Delete a wall and the doors and windows in it. */
export function deleteWall(plan: Plan, id: string): Plan {
  return finish({
    ...plan,
    walls: plan.walls.filter((w) => w.id !== id),
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
  const width = mm(Math.min(d.width, l));
  const offset = mm(Math.max(0, Math.min(centre - width / 2, l - width)));
  const id = nextId(plan, kind);
  const base = { id, wall: wallId, offset, width, material: d.material, thickness: d.thickness };
  if (kind === 'door') {
    // Swing towards the side of the click, if there was one.
    const side = p ? Math.sign(cross2(sub(wall.b, wall.a), sub(p, wall.a))) : 1;
    const door: Door = { ...base, hinge: 'a', swing: side < 0 ? -1 : 1 };
    return { plan: { ...plan, doors: [...plan.doors, door] }, id };
  }
  const win: Window = base;
  return { plan: { ...plan, windows: [...plan.windows, win] }, id };
}

const cross2 = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];

/** Slide an opening so its centre sits `centre` metres along its wall. */
export function moveOpening(plan: Plan, id: string, centre: number): Plan {
  const lengths = new Map(plan.walls.map((w) => [w.id, frame(w).length]));
  const place = <T extends Opening>(o: T): T => {
    if (o.id !== id) return o;
    const l = lengths.get(o.wall) ?? o.width;
    return { ...o, offset: mm(Math.max(0, Math.min(centre - o.width / 2, l - o.width))) };
  };
  return { ...plan, doors: plan.doors.map(place), windows: plan.windows.map(place) };
}

export function updateOpening(
  plan: Plan,
  id: string,
  patch: Partial<Omit<Door, 'id' | 'wall'>>,
): Plan {
  const apply = <T extends Opening>(o: T): T => {
    if (o.id !== id) return o;
    const next = { ...o, ...patch } as T;
    if (patch.width !== undefined) {
      // Keep the centre where it was.
      next.width = mm(Math.max(0.1, patch.width));
      next.offset = mm(o.offset + (o.width - next.width) / 2);
    }
    if (patch.thickness !== undefined) next.thickness = mm(Math.max(0.001, patch.thickness));
    return next;
  };
  return fitOpenings({ ...plan, doors: plan.doors.map(apply), windows: plan.windows.map(apply) });
}

export function deleteOpening(plan: Plan, id: string): Plan {
  return {
    ...plan,
    doors: plan.doors.filter((d) => d.id !== id),
    windows: plan.windows.filter((w) => w.id !== id),
  };
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
    polygon: polygon.map(mmPoint),
  };
  return { plan: { ...plan, rooms: [...plan.rooms, room] }, id };
}

export function updateRoom(plan: Plan, id: string, patch: Partial<Omit<Room, 'id'>>): Plan {
  return {
    ...plan,
    rooms: plan.rooms.map((r) => {
      if (r.id !== id) return r;
      const next: Room = { ...r, ...patch };
      if (patch.area_id === null || patch.area_id === '') delete next.area_id;
      return next;
    }),
  };
}

export function moveRoomVertex(plan: Plan, id: string, index: number, to: Point): Plan {
  return {
    ...plan,
    rooms: plan.rooms.map((r) =>
      r.id === id ? { ...r, polygon: r.polygon.map((p, i) => (i === index ? mmPoint(to) : p)) } : r,
    ),
  };
}

export function deleteRoom(plan: Plan, id: string): Plan {
  return { ...plan, rooms: plan.rooms.filter((r) => r.id !== id) };
}

/**
 * Scale the drawing about the origin, for calibration: positions, opening sizes and the underlay
 * grow by `k`; wall and opening thicknesses are real sizes and stay as they are.
 */
export function scalePlan(plan: Plan, k: number): Plan {
  if (!(k > 0) || !Number.isFinite(k)) throw new Error('scale factor must be positive');
  const s = (p: Point): Point => mmPoint([p[0] * k, p[1] * k]);
  const op = <T extends Opening>(o: T): T => ({
    ...o,
    offset: mm(o.offset * k),
    width: mm(o.width * k),
  });
  return withOutline({
    ...plan,
    walls: plan.walls.map((w) => ({ ...w, a: s(w.a), b: s(w.b) })),
    rooms: plan.rooms.map((r) => ({ ...r, polygon: r.polygon.map(s) })),
    doors: plan.doors.map(op),
    windows: plan.windows.map(op),
    sources: plan.sources.map((x) => ({ ...x, position: s(x.position) })),
    ...(plan.devices
      ? { devices: plan.devices.map((x) => ({ ...x, position: s(x.position) })) }
      : {}),
    underlay: plan.underlay
      ? { ...plan.underlay, scale: plan.underlay.scale * k, origin: s(plan.underlay.origin) }
      : plan.underlay,
  });
}

/** Scale factor that makes the distance between two drawn points equal `metres`. */
export function twoPointFactor(p: Point, q: Point, metres: number): number {
  const d = dist(p, q);
  if (d <= 0 || !(metres > 0)) throw new Error('need two distinct points and a positive distance');
  return metres / d;
}

/** Scale factor that makes a drawn polygon's area equal `squareMetres`. */
export function areaFactor(polygon: readonly Point[], squareMetres: number): number {
  let s = 0;
  for (let i = 0; i < polygon.length; i++)
    s += cross2(polygon[i]!, polygon[(i + 1) % polygon.length]!);
  const a = Math.abs(s / 2);
  if (a <= 0 || !(squareMetres > 0))
    throw new Error('need a room with an area and a positive target');
  return Math.sqrt(squareMetres / a);
}

/**
 * Points that snapping prefers: wall endpoints and, with `faces`, the corners where the faces of
 * joined walls meet (the inside corners of rooms), free wall-end corners and room corners.
 */
export function snapTargets(plan: Plan, faces: boolean): Point[] {
  const pts: Point[] = [];
  for (const w of plan.walls) pts.push(w.a, w.b);
  if (!faces) return pts;
  for (const w of plan.walls) pts.push(...wallRect(w, 0, frame(w).length, true, true));
  const ws = plan.walls;
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const p = ws[i]!;
      const q = ws[j]!;
      const joint = [p.a, p.b].find((e) => same(e, q.a) || same(e, q.b));
      if (!joint) continue;
      const fp = frame(p);
      const fq = frame(q);
      if (Math.abs(fp.u[0] * fq.u[1] - fp.u[1] * fq.u[0]) < 1e-9) continue;
      for (const sp of [1, -1]) {
        for (const sq of [1, -1]) {
          const a0 = add(p.a, [fp.n[0] * sp * (p.thickness / 2), fp.n[1] * sp * (p.thickness / 2)]);
          const b0 = add(q.a, [fq.n[0] * sq * (q.thickness / 2), fq.n[1] * sq * (q.thickness / 2)]);
          const den = fp.u[0] * fq.u[1] - fp.u[1] * fq.u[0];
          const t = ((b0[0] - a0[0]) * fq.u[1] - (b0[1] - a0[1]) * fq.u[0]) / den;
          pts.push(mmPoint([a0[0] + fp.u[0] * t, a0[1] + fp.u[1] * t]));
        }
      }
    }
  }
  for (const r of plan.rooms) pts.push(...r.polygon);
  return pts;
}

export interface SnapOptions {
  /** Snap radius in metres (the editor converts from screen pixels). */
  radius: number;
  grid: number;
  /** Previous point: lock to horizontal/vertical when nearly so. */
  anchor?: Point | null;
  targets: readonly Point[];
  /** Ignore targets at these points (the endpoint being dragged). */
  exclude?: Point | null;
}

/** Snap to a nearby target, else to the grid, then straighten against the anchor. */
export function snap(p: Point, o: SnapOptions): { point: Point; target: boolean } {
  let best: Point | null = null;
  let bestD = o.radius;
  for (const t of o.targets) {
    if (o.exclude && same(t, o.exclude)) continue;
    const d = dist(t, p);
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  if (best) return { point: best, target: true };
  const g = o.grid > 0 ? o.grid : 0.001;
  let q: Point = [mm(Math.round(p[0] / g) * g), mm(Math.round(p[1] / g) * g)];
  if (o.anchor) {
    const dx = Math.abs(q[0] - o.anchor[0]);
    const dy = Math.abs(q[1] - o.anchor[1]);
    // Within ~5 degrees of an axis: make it exact.
    if (dy < dx * 0.09) q = [q[0], o.anchor[1]];
    else if (dx < dy * 0.09) q = [o.anchor[0], q[1]];
  }
  return { point: q, target: false };
}

/** Move a whole room by `delta`. */
export function moveRoom(plan: Plan, id: string, delta: Point): Plan {
  return {
    ...plan,
    rooms: plan.rooms.map((r) =>
      r.id === id ? { ...r, polygon: r.polygon.map((p) => mmPoint(add(p, delta))) } : r,
    ),
  };
}

/** Add or override a material in the plan's own table. */
export function setMaterial(plan: Plan, material: Material): Plan {
  const rest = (plan.materials ?? []).filter((m) => m.id !== material.id);
  return {
    ...plan,
    materials: [...rest, { ...material, db_per_cm: Math.max(0, material.db_per_cm) }],
  };
}

export { DEFAULT_TX_DBM };

/** Place a source; access points and radios get a default reference level. */
export function addSource(
  plan: Plan,
  kind: SourceKind,
  position: Point,
  entity_id = '',
  area_id: string | null = null,
): { plan: Plan; id: string } {
  const id = nextId(plan, kind === 'sensor' ? 'sensor' : kind);
  const source: Source = { id, kind, entity_id, position: mmPoint(position) };
  if (area_id) source.area_id = area_id;
  if (kind !== 'sensor') source.tx_dbm = DEFAULT_TX_DBM[kind];
  return { plan: { ...plan, sources: [...plan.sources, source] }, id };
}

export function moveSource(plan: Plan, id: string, to: Point): Plan {
  return {
    ...plan,
    sources: plan.sources.map((x) => (x.id === id ? { ...x, position: mmPoint(to) } : x)),
  };
}

/** Change a source. Switching to a sensor drops `tx_dbm`; switching away adds the default. */
export function updateSource(plan: Plan, id: string, patch: Partial<Omit<Source, 'id'>>): Plan {
  return {
    ...plan,
    sources: plan.sources.map((x) => {
      if (x.id !== id) return x;
      const next: Source = { ...x, ...patch };
      if (next.kind === 'sensor') delete next.tx_dbm;
      else if (next.tx_dbm === undefined) next.tx_dbm = DEFAULT_TX_DBM[next.kind];
      if (!next.area_id) delete next.area_id;
      return next;
    }),
  };
}

export function deleteSource(plan: Plan, id: string): Plan {
  return { ...plan, sources: plan.sources.filter((x) => x.id !== id) };
}

// ---- devices ----

/** Place an entity as a device marker. An entity already on the plan is moved instead. */
export function addDevice(
  plan: Plan,
  entity_id: string,
  position: Point,
): { plan: Plan; id: string } {
  const devices = plan.devices ?? [];
  const existing = devices.find((d) => d.entity_id === entity_id);
  if (existing) return { plan: moveDevice(plan, existing.id, position), id: existing.id };
  const id = nextId(plan, 'device');
  return {
    plan: { ...plan, devices: [...devices, { id, entity_id, position: mmPoint(position) }] },
    id,
  };
}

export function moveDevice(plan: Plan, id: string, to: Point): Plan {
  return {
    ...plan,
    devices: (plan.devices ?? []).map((d) => (d.id === id ? { ...d, position: mmPoint(to) } : d)),
  };
}

export function updateDevice(plan: Plan, id: string, entity_id: string): Plan {
  return {
    ...plan,
    devices: (plan.devices ?? []).map((d) => (d.id === id ? { ...d, entity_id } : d)),
  };
}

export function deleteDevice(plan: Plan, id: string): Plan {
  return { ...plan, devices: (plan.devices ?? []).filter((d) => d.id !== id) };
}
