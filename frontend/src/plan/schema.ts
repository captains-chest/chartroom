// The plan's shape, written down once: each list and the fields of its items, with the check for
// each field, what a missing list defaults to, and the legacy forms folded in on the way. A stored
// plan and a plan file both come in through `parsePlan`; `validatePlan` (functions.ts) then checks
// what holds across items (references, ranges) and trusts the types checked here.
//
// To add a field: its type in models.ts, its check below.
import { PLAN_SCHEMA_VERSION } from './constants';
import { uniqueIds } from './functions';
import type { Plan, Room } from './models';

type Check = (v: unknown) => boolean;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const pos: Check = (v) => num(v) && (v as number) > 0;
const str: Check = (v) => typeof v === 'string';
const optStr: Check = (v) => v == null || str(v);
const pt: Check = (v) => Array.isArray(v) && v.length === 2 && v.every(num);
const pts: Check = (v) => Array.isArray(v) && v.every(pt);
const strs: Check = (v) => Array.isArray(v) && v.every(str);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const opening = { id: str, wall: str, offset: num, width: num, material: str, thickness: num };

interface ListSpec {
  /** Each item's fields and their checks. */
  readonly fields: Readonly<Record<string, Check>>;
  /**
   * May be missing, in plans saved before the list existed: `fill` makes it an empty list, `leave`
   * leaves it out. Without it, a missing list is filled in and a plan file must have it.
   */
  readonly optional?: 'fill' | 'leave';
  /** The item as the panel uses it, from a stored one (legacy forms folded in). */
  readonly normalize?: (item: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * A stored room as the panel uses it: a single `area_id` from plans saved before rooms could link
 * several areas becomes `area_ids`, and an empty list is dropped.
 */
function normalizeRoom(raw: Record<string, unknown>): Record<string, unknown> {
  const { area_id, area_ids, ...room } = raw as Partial<Room> & { area_id?: unknown };
  const ids = uniqueIds([...(Array.isArray(area_ids) ? area_ids : []), area_id]);
  return ids.length > 0 ? { ...room, area_ids: ids } : room;
}

/** Every list in a plan, in the order problems are reported. */
export const PLAN_LISTS: Readonly<Record<string, ListSpec>> = {
  walls: { fields: { id: str, a: pt, b: pt, thickness: num, material: str } },
  doors: {
    fields: {
      ...opening,
      entity_id: optStr,
      hinge: (v) => v === 'a' || v === 'b',
      swing: (v) => v === 1 || v === -1,
    },
  },
  windows: { fields: { ...opening, entity_id: optStr } },
  rooms: {
    fields: { id: str, name: str, polygon: pts, area_ids: (v) => v === undefined || strs(v) },
    normalize: normalizeRoom,
  },
  sources: {
    fields: {
      id: str,
      kind: (v) => v === 'sensor' || v === 'access_point' || v === 'radio',
      entity_id: str,
      position: pt,
      area_id: optStr,
      tx_dbm: (v) => v === undefined || num(v),
    },
  },
  // Plans from before device markers have none: an empty list.
  devices: { fields: { id: str, entity_id: str, position: pt }, optional: 'fill' },
  materials: { fields: { id: str, name: str, db_per_cm: num }, optional: 'leave' },
};

const UNDERLAY: Readonly<Record<string, Check>> = {
  url: str,
  width_px: pos,
  height_px: pos,
  scale: pos,
  origin: pt,
  opacity: (v) => num(v) && (v as number) >= 0 && (v as number) <= 1,
};

/**
 * A stored plan as the panel uses it: missing lists filled in, legacy forms folded in, the storage
 * `id` and any extra keys kept as they are. Values of the wrong type are kept for `shapeProblems`
 * to report. Throws on something that is not a plan, or a schema version this build does not know.
 */
export function normalizePlan(raw: unknown): Plan {
  if (!isObject(raw)) throw new Error('not a plan');
  const version = raw['schema_version'] ?? PLAN_SCHEMA_VERSION;
  if (version !== PLAN_SCHEMA_VERSION)
    throw new Error(`unsupported schema_version ${JSON.stringify(version)}`);
  const out: Record<string, unknown> = {
    ...raw,
    schema_version: PLAN_SCHEMA_VERSION,
    name: typeof raw['name'] === 'string' ? raw['name'] : 'Plan',
    floor_id: raw['floor_id'] ?? null,
    outline: raw['outline'] ?? [],
  };
  for (const [key, spec] of Object.entries(PLAN_LISTS)) {
    const items = raw[key];
    if (items == null) {
      if (spec.optional !== 'leave') out[key] = [];
    } else if (Array.isArray(items) && spec.normalize) {
      const normalize = spec.normalize;
      out[key] = items.map((item) => (isObject(item) ? normalize(item) : item));
    }
  }
  return out as unknown as Plan;
}

/**
 * Problems with a normalised plan's structure: lists that are not lists, fields of the wrong type,
 * numbers that are not finite. Empty when the plan has the shape its types say.
 */
export function shapeProblems(plan: Plan): string[] {
  const out: string[] = [];
  const raw = plan as unknown as Record<string, unknown>;
  const check = (where: string, item: unknown, fields: Readonly<Record<string, Check>>): void => {
    if (!isObject(item)) return void out.push(`${where} is not an object`);
    for (const [key, ok] of Object.entries(fields))
      if (!ok(item[key])) out.push(`${where}: bad or missing ${key}`);
  };
  if (!pts(raw['outline'])) out.push('outline is not a list of points');
  for (const [list, spec] of Object.entries(PLAN_LISTS)) {
    const items = raw[list];
    if (items === undefined && spec.optional) continue;
    if (Array.isArray(items)) items.forEach((item, i) => check(`${list}[${i}]`, item, spec.fields));
    else out.push(`${list} is not a list`);
  }
  if (raw['underlay'] != null) check('underlay', raw['underlay'], UNDERLAY);
  return out;
}

/**
 * The parts of a damaged plan nothing can draw, taken out: a list that is not a list becomes
 * empty, an item that is not an object or has a bad field goes, and an outline that is not points
 * becomes empty. The problems say what went (the loader logs them); a later save stores the plan
 * without them. A bad underlay is the loader's to drop (ownUnderlayOnly), which says so.
 */
function repair(plan: Plan): Plan {
  const raw = { ...(plan as unknown as Record<string, unknown>) };
  if (!pts(raw['outline'])) raw['outline'] = [];
  for (const [list, spec] of Object.entries(PLAN_LISTS)) {
    const items = raw[list];
    if (items === undefined && spec.optional) continue;
    const sound = (item: unknown): boolean =>
      isObject(item) && Object.entries(spec.fields).every(([key, ok]) => ok(item[key]));
    raw[list] = Array.isArray(items) ? items.filter(sound) : [];
  }
  return raw as unknown as Plan;
}

export interface ParsedPlan {
  plan: Plan;
  /** What is wrong with the plan's structure (shapeProblems); empty when nothing is. */
  problems: string[];
}

/**
 * A plan from outside, normalised and checked against the schema. `repair`: a stored plan, which
 * must still open when damaged, comes back with what nothing could draw taken out (the problems
 * still say what was wrong). Without it, a plan file the caller refuses when there are problems.
 * Throws like `normalizePlan`.
 */
export function parsePlan(raw: unknown, { repair: fix = false } = {}): ParsedPlan {
  const plan = normalizePlan(raw);
  const problems = shapeProblems(plan);
  return { plan: fix && problems.length > 0 ? repair(plan) : plan, problems };
}
