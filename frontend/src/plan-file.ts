// A plan as a .json file: the plan as stored (without its storage id), and optionally its underlay
// image embedded as a data URL. A file read back in is untrusted: its structure is checked here,
// then it goes through the same normalising and validation as a stored plan. Loaded with the editor.
import { PLAN_ID_PATTERN } from './plan/constants';
import { normalizePlan, validatePlan } from './plan/functions';
import type { Plan } from './plan/models';
import { MAX_BYTES, UNDERLAY_TYPES, underlayPath } from './underlay';

/** The key that carries the embedded underlay image, next to the plan's own keys. */
export const IMAGE_KEY = 'underlay_image';
/** Largest file read: a 10 MB image grows by a third as base64, plus the plan. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** The file's text: the plan as stored, with `image` (a data URL) when the underlay is embedded. */
export function planFileJson(plan: Plan, image: string | null = null): string {
  const { id: _id, ...stored } = plan as Plan & { id?: string };
  const out = image && stored.underlay ? { ...stored, [IMAGE_KEY]: image } : stored;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** A download name for the plan: its storage id is already safe as a file name. */
export const planFileName = (planId: string): string => `chartroom-${planId}.json`;

/** A blob as a `data:` URL. */
export async function dataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  // String.fromCharCode takes its arguments on the stack: go in slices.
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}

/** A base64 `data:` URL of one of the underlay image types as a blob, or null. */
export async function imageBlob(url: string): Promise<Blob | null> {
  const m = /^data:([a-z/+]+);base64,[A-Za-z0-9+/]*={0,2}$/.exec(url);
  if (!m || !UNDERLAY_TYPES.test(m[1]!)) return null;
  try {
    return await (await fetch(url)).blob();
  } catch {
    return null;
  }
}

/**
 * The plan whose stored image `url` is (as the upload returns it: the path, maybe `?v=<hash>`), or
 * null for any other URL. The image is fetched with the user's token, so a plan from outside must
 * not point it anywhere else.
 */
export function underlayPlanId(url: string): string | null {
  const prefix = underlayPath('');
  const m =
    url.startsWith(prefix) && /^([^/?#]+)(\?v=[0-9a-f]{1,64})?$/.exec(url.slice(prefix.length));
  return m && PLAN_ID_PATTERN.test(m[1]!) ? m[1]! : null;
}

type Check = (v: unknown) => boolean;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const pos: Check = (v) => num(v) && (v as number) > 0;
const str: Check = (v) => typeof v === 'string';
const optStr: Check = (v) => v == null || str(v);
const pt: Check = (v) => Array.isArray(v) && v.length === 2 && v.every(num);
const pts: Check = (v) => Array.isArray(v) && v.every(pt);
const opening = { id: str, wall: str, offset: num, width: num, material: str, thickness: num };
/** Each list's items' fields; `devices` and `materials` may be missing. */
const LISTS: Record<string, Record<string, Check>> = {
  walls: { id: str, a: pt, b: pt, thickness: num, material: str },
  doors: {
    ...opening,
    entity_id: optStr,
    hinge: (v) => v === 'a' || v === 'b',
    swing: (v) => v === 1 || v === -1,
  },
  windows: { ...opening, entity_id: optStr },
  rooms: { id: str, name: str, polygon: pts, area_id: optStr },
  sources: {
    id: str,
    kind: (v) => v === 'sensor' || v === 'access_point' || v === 'radio',
    entity_id: str,
    position: pt,
    area_id: optStr,
    tx_dbm: (v) => v === undefined || num(v),
  },
  devices: { id: str, entity_id: str, position: pt },
  materials: { id: str, name: str, db_per_cm: num },
};
const UNDERLAY = {
  url: str,
  width_px: pos,
  height_px: pos,
  scale: pos,
  origin: pt,
  opacity: (v: unknown) => num(v) && (v as number) >= 0 && (v as number) <= 1,
};

/**
 * Problems with a normalised plan's structure: lists that are not lists, fields of the wrong type,
 * numbers that are not finite. `validatePlan` trusts the types, so a plan from outside passes this
 * first.
 */
export function shapeProblems(plan: Plan): string[] {
  const out: string[] = [];
  const raw = plan as unknown as Record<string, unknown>;
  const check = (where: string, item: unknown, fields: Record<string, Check>): void => {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return void out.push(`${where} is not an object`);
    for (const [key, ok] of Object.entries(fields))
      if (!ok((item as Record<string, unknown>)[key])) out.push(`${where}: bad or missing ${key}`);
  };
  if (!pts(raw['outline'])) out.push('outline is not a list of points');
  for (const [list, fields] of Object.entries(LISTS)) {
    const items = raw[list];
    if (items === undefined && (list === 'materials' || list === 'devices')) continue;
    if (Array.isArray(items)) items.forEach((item, i) => check(`${list}[${i}]`, item, fields));
    else out.push(`${list} is not a list`);
  }
  if (raw['underlay'] != null) check('underlay', raw['underlay'], UNDERLAY);
  return out;
}

export type PlanFileResult =
  | {
      ok: true;
      /** The plan to save to `planId`, on `floorId`. */
      plan: Plan;
      /** The embedded image to upload as the plan's underlay before saving, if any. */
      image: Blob | null;
      /** What was changed or left out on the way in. */
      notes: string[];
    }
  | { ok: false; problems: string[] };

/**
 * Read a plan file for the plan `planId` on the floor `floorId` (the plan it replaces). The plan
 * keeps the file's contents but takes this floor; its underlay comes along only embedded, or when
 * it is already this plan's own image.
 */
export async function readPlanFile(
  text: string,
  planId: string,
  floorId: string | null,
): Promise<PlanFileResult> {
  const fail = (...problems: string[]): PlanFileResult => ({ ok: false, problems });
  if (text.length > MAX_FILE_BYTES) return fail('the file is larger than 16 MB');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail(`not JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return fail('not a Chartroom plan: expected a JSON object');
  // Other keys stay, as in a stored plan (the example's `meta`). A plan copied from
  // `chartroom/plans/get` carries its storage id, which is not the file's to set.
  const { [IMAGE_KEY]: imageUrl, id: _id, ...rest } = raw as Record<string, unknown>;
  let plan: Plan;
  try {
    plan = normalizePlan(rest);
  } catch (err) {
    return fail((err as Error).message);
  }
  const shape = shapeProblems(plan);
  if (shape.length > 0) return fail(...shape);
  const problems = validatePlan(plan);
  if (problems.length > 0) return fail(...problems);

  const notes: string[] = [];
  let image: Blob | null = null;
  if (imageUrl != null) {
    image = typeof imageUrl === 'string' ? await imageBlob(imageUrl) : null;
    if (!image) return fail(`${IMAGE_KEY} is not a base64 PNG, JPEG, WebP or SVG data URL`);
    if (image.size > MAX_BYTES) return fail(`${IMAGE_KEY} is larger than 10 MB`);
    if (!plan.underlay) {
      notes.push('Left out the embedded image: the plan has no underlay to place it.');
      image = null;
    }
  } else if (plan.underlay && underlayPlanId(plan.underlay.url) !== planId) {
    notes.push(
      'Left out the underlay: its image is not in the file. Export with the underlay to bring it along.',
    );
    plan = { ...plan, underlay: null };
  }
  return { ok: true, plan: { ...plan, floor_id: floorId }, image, notes };
}
