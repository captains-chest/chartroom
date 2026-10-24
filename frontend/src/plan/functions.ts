// Reading, checking and summarising a plan. Editing operations are in ops.ts.
import { DEFAULT_MATERIALS, LIMITS, PLAN_SCHEMA_VERSION } from './constants';
import type { Material, Plan, Source, Wall } from './models';
import type { Point } from './types';

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
