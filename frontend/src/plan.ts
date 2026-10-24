// The floor-plan model (Phase 1). This is the wire and storage format: the panel sends it to
// `chartroom/plans/save`, the integration stores it as-is, and the renderer reads it. Field names are
// snake_case to match Home Assistant's own APIs.
//
// Coordinates are metres in plan space: x to the right, y down (the same orientation as SVG), with
// the origin at the top-left of the plan's outline. See docs/render-design.md, "What Phase 1 must
// provide".

/** Bump when a stored plan needs migrating; readers reject versions they don't know. */
export const PLAN_SCHEMA_VERSION = 1;

/** A point in plan space, in metres. */
export type Point = readonly [x: number, y: number];

/**
 * A wall material. Radio loss through a wall is `db_per_cm * thickness_cm`; the shader reads it from
 * the wall texture, so adding materials costs nothing per pixel.
 */
export interface Material {
  id: string;
  name: string;
  /** Signal loss in dB per centimetre of thickness (2.4 GHz ballpark; Phase 4 can fit it). */
  db_per_cm: number;
}

/** Built-in materials. A plan may add its own or override these by id. */
export const DEFAULT_MATERIALS: readonly Material[] = [
  { id: 'exterior', name: 'Exterior masonry / concrete', db_per_cm: 0.5 },
  { id: 'partition', name: 'Light partition', db_per_cm: 0.3 },
  { id: 'wood_door', name: 'Wooden door', db_per_cm: 0.75 },
  { id: 'glass', name: 'Glazing', db_per_cm: 1 },
];

/** A straight wall: centreline from `a` to `b`, with its full thickness and material. */
export interface Wall {
  id: string;
  a: Point;
  b: Point;
  /** Full thickness in metres, centred on the a–b line. */
  thickness: number;
  material: string;
}

/** Shared by doors and windows: a gap in a wall, measured along it from the wall's `a` end. */
export interface Opening {
  id: string;
  wall: string;
  /** Distance in metres from the wall's `a` end to the near edge of the opening. */
  offset: number;
  /** Width of the opening along the wall, in metres. */
  width: number;
  /** What fills the opening when it is closed, and how thick that is (metres). */
  material: string;
  thickness: number;
  /** Optional binary sensor / cover that says whether it is open. */
  entity_id?: string | null;
}

export interface Door extends Opening {
  /** Which edge of the opening carries the hinge: the one nearer the wall's `a` end, or `b` end. */
  hinge: 'a' | 'b';
  /**
   * Which side of the wall the leaf swings into, as the sign of the 2D cross product
   * `(b - a) x (p - a)` for points `p` on that side (in plan space, y down).
   */
  swing: 1 | -1;
}

export type Window = Opening;

export interface Room {
  id: string;
  name: string;
  /** Inner faces of the walls, in order (either winding). */
  polygon: Point[];
  /** The Home Assistant area this room shows, if any. */
  area_id?: string | null;
}

export type SourceKind = 'sensor' | 'access_point' | 'radio';

/** Something that feeds a layer: a temperature/humidity sensor, an access point, a radio. */
export interface Source {
  id: string;
  kind: SourceKind;
  entity_id: string;
  position: Point;
  /** The Home Assistant area the entity belongs to, if any (several areas can share one room). */
  area_id?: string | null;
  /** Radios and access points: transmit power or reference loss at 1 m, in dBm. */
  tx_dbm?: number;
}

/**
 * A raster or SVG drawing shown under the plan to trace over. The file itself is stored by the
 * integration (`/api/chartroom/underlay/<plan_id>`); the plan only says where it sits.
 */
export interface Underlay {
  /** URL path of the stored image, relative to Home Assistant. */
  url: string;
  /** Natural size of the image in pixels. */
  width_px: number;
  height_px: number;
  /** Metres per image pixel. */
  scale: number;
  /** Plan position of the image's top-left corner, in metres. */
  origin: Point;
  /** 0..1 */
  opacity: number;
}

/** A Home Assistant entity shown as a live marker on the plan. Its name and icon come from HA. */
export interface Device {
  id: string;
  entity_id: string;
  position: Point;
}

export interface Plan {
  schema_version: typeof PLAN_SCHEMA_VERSION;
  name: string;
  floor_id?: string | null;
  /** Exterior polygon (outer faces of the outer walls), so the outside fade knows what is inside. */
  outline: Point[];
  walls: Wall[];
  rooms: Room[];
  doors: Door[];
  windows: Window[];
  sources: Source[];
  /** Live device markers (Phase 2). Older plans have none. */
  devices?: Device[];
  /** Materials added to or overriding DEFAULT_MATERIALS. */
  materials?: Material[];
  underlay?: Underlay | null;
}

/** A new, empty plan. */
export function emptyPlan(name: string, floor_id: string | null = null): Plan {
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    name,
    floor_id,
    outline: [],
    walls: [],
    rooms: [],
    doors: [],
    windows: [],
    sources: [],
  };
}

/**
 * A stored plan as the panel uses it: missing lists filled in, the storage `id` and any extra keys
 * kept as they are. Throws on a schema version this build does not know.
 */
export function normalizePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== 'object') throw new Error('not a plan');
  const r = raw as Partial<Plan> & { schema_version?: unknown; name?: unknown };
  const version = r.schema_version ?? PLAN_SCHEMA_VERSION;
  if (version !== PLAN_SCHEMA_VERSION)
    throw new Error(`unsupported schema_version ${String(version)}`);
  return {
    ...r,
    schema_version: PLAN_SCHEMA_VERSION,
    name: typeof r.name === 'string' ? r.name : 'Plan',
    floor_id: r.floor_id ?? null,
    outline: r.outline ?? [],
    walls: r.walls ?? [],
    rooms: r.rooms ?? [],
    doors: r.doors ?? [],
    windows: r.windows ?? [],
    sources: r.sources ?? [],
    devices: r.devices ?? [],
  };
}

/** Signed area of a polygon (shoelace); positive when clockwise in y-down plan space. */
export function signedArea(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Area of a simple polygon in square metres. */
export function polygonArea(polygon: readonly Point[]): number {
  return Math.abs(signedArea(polygon));
}

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(polygon: readonly Point[]): Point {
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    const cross = x1 * y2 - x2 * y1;
    a2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

/** Length of a wall's centreline. */
export function wallLength(wall: Wall): number {
  return Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
}

/** The point `distance` metres along a wall from its `a` end. */
export function pointAlong(wall: Wall, distance: number): Point {
  const t = distance / wallLength(wall);
  return [wall.a[0] + (wall.b[0] - wall.a[0]) * t, wall.a[1] + (wall.b[1] - wall.a[1]) * t];
}

/** Materials in effect for a plan: the defaults, then the plan's own by id. */
export function materialsOf(plan: Plan): Map<string, Material> {
  const map = new Map(DEFAULT_MATERIALS.map((m) => [m.id, m]));
  for (const m of plan.materials ?? []) map.set(m.id, m);
  return map;
}

/** Radio loss through a wall or closed opening, in dB. */
export function lossDb(material: Material, thickness: number): number {
  return material.db_per_cm * thickness * 100;
}

/** Problems that make a plan unusable; empty when it is fine. */
export function validatePlan(plan: Plan): string[] {
  const problems: string[] = [];
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) {
    problems.push(`unsupported schema_version ${String(plan.schema_version)}`);
  }
  const materials = materialsOf(plan);
  const ids = new Set<string>();
  const unique = (kind: string, id: string): void => {
    if (ids.has(id)) problems.push(`duplicate id ${id}`);
    ids.add(id);
    if (!/^[a-z0-9_-]+$/.test(id)) problems.push(`${kind} id ${id} is not [a-z0-9_-]`);
  };
  const walls = new Map(plan.walls.map((w) => [w.id, w]));
  for (const w of plan.walls) {
    unique('wall', w.id);
    if (!(w.thickness > 0)) problems.push(`wall ${w.id} has no thickness`);
    if (!materials.has(w.material)) problems.push(`wall ${w.id}: unknown material ${w.material}`);
    if (wallLength(w) === 0) problems.push(`wall ${w.id} has zero length`);
  }
  for (const o of [...plan.doors, ...plan.windows]) {
    unique('opening', o.id);
    const wall = walls.get(o.wall);
    if (!wall) {
      problems.push(`opening ${o.id}: unknown wall ${o.wall}`);
      continue;
    }
    if (o.offset < 0 || o.width <= 0 || o.offset + o.width > wallLength(wall) + 1e-9) {
      problems.push(`opening ${o.id} does not fit on wall ${o.wall}`);
    }
    if (!materials.has(o.material))
      problems.push(`opening ${o.id}: unknown material ${o.material}`);
  }
  for (const r of plan.rooms) {
    unique('room', r.id);
    if (r.polygon.length < 3) problems.push(`room ${r.id} has fewer than 3 corners`);
  }
  for (const s of plan.sources) unique('source', s.id);
  const placed = new Set<string>();
  for (const d of plan.devices ?? []) {
    unique('device', d.id);
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(d.entity_id))
      problems.push(`device ${d.id}: bad entity_id ${d.entity_id}`);
    if (placed.has(d.entity_id)) problems.push(`device ${d.id}: ${d.entity_id} is placed twice`);
    placed.add(d.entity_id);
  }
  if (plan.outline.length < 3 && plan.walls.length > 0) {
    problems.push('outline has fewer than 3 corners');
  }
  return problems;
}

/**
 * Limits per floor from docs/render-design.md, where the editor warns (it still saves). Above the
 * wall and device limits the plan may get slow on phones and wall tablets; access points and radios
 * are the signal map's hard limit (MAX_SIGNAL_SOURCES): it leaves out any beyond it.
 */
export const LIMITS = { walls: 512, accessPoints: 32, devices: 256 } as const;

/** Default reference level at 1 m for new access points and radios, in dBm. */
export const DEFAULT_TX_DBM = { access_point: -40, radio: -45 } as const;

/** Access points and radios: the sources the signal layer traces rays from. */
export const isSignalSource = (s: Source): boolean =>
  s.kind === 'access_point' || s.kind === 'radio';

/**
 * The entities a plan reads: its sources', devices' and doors' and windows' (open or closed).
 * Sensors come first, apart, so history can fetch them as statistics.
 */
export const planEntities = (plan: Plan | null): { sensors: string[]; others: string[] } => {
  const sensors = new Set<string>();
  const others = new Set<string>();
  for (const s of plan?.sources ?? [])
    if (s.entity_id) (s.kind === 'sensor' ? sensors : others).add(s.entity_id);
  for (const d of plan?.devices ?? []) others.add(d.entity_id);
  for (const o of [...(plan?.doors ?? []), ...(plan?.windows ?? [])])
    if (o.entity_id) others.add(o.entity_id);
  for (const id of sensors) others.delete(id);
  return { sensors: [...sensors], others: [...others] };
};

/** Warnings for a plan (one floor) that is over the soft limits. */
export function limitWarnings(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.walls.length > LIMITS.walls)
    out.push(
      `${plan.walls.length} walls on this floor (more than ${LIMITS.walls}): the signal map may be slow on phones and tablets.`,
    );
  const aps = plan.sources.filter(isSignalSource).length;
  if (aps > LIMITS.accessPoints)
    out.push(
      `${aps} access points and radios on this floor (more than ${LIMITS.accessPoints}): the signal map uses the first ${LIMITS.accessPoints} and leaves out the rest.`,
    );
  const devices = plan.devices?.length ?? 0;
  if (devices > LIMITS.devices)
    out.push(
      `${devices} devices on this floor (more than ${LIMITS.devices}): markers may be slow to update on phones and tablets.`,
    );
  return out;
}
