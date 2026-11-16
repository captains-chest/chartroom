// A plan as a .json file: the plan as stored (without its storage id), and optionally its underlay
// image, embedded as a data URL or saved as its own file next to it that the .json names. Files
// read back in are untrusted: they go through the plan schema (plan/schema.ts) like a stored plan,
// but a file with any problem is refused, and then through validatePlan. Loaded with the editor.
import { validatePlan } from './plan/functions';
import { parsePlan } from './plan/schema';
import type { Plan } from './plan/models';
import { MAX_BYTES, UNDERLAY_TYPES } from './underlay';
import { underlayPlanId } from './underlay-url';

/** The key that carries the embedded underlay image, next to the plan's own keys. */
export const IMAGE_KEY = 'underlay_image';
/** The key that names the underlay image file exported next to the plan. */
export const IMAGE_FILE_KEY = 'underlay_file';
/** Largest file read: a 10 MB image grows by a third as base64, plus the plan. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The file's text: the plan as stored, with the underlay image when the plan has one: `image` is
 * its data URL to embed, or `{ file }` the name of the image file saved next to it.
 */
export function planFileJson(plan: Plan, image: string | { file: string } | null = null): string {
  const { id: _id, ...stored } = plan as Plan & { id?: string };
  const out =
    !image || !stored.underlay
      ? stored
      : typeof image === 'string'
        ? { ...stored, [IMAGE_KEY]: image }
        : { ...stored, [IMAGE_FILE_KEY]: image.file };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** A download name for the plan: its storage id is already safe as a file name. */
export const planFileName = (planId: string): string => `chartroom-${planId}.json`;

/** Each underlay image type's file extension, as the integration stores it. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
const TYPE_OF_EXTENSION: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type])),
  jpeg: 'image/jpeg',
};

/** Each underlay image type as people name it, with its article. */
const TYPE_NAMES: Record<string, string> = {
  'image/png': 'a PNG',
  'image/jpeg': 'a JPEG',
  'image/webp': 'a WebP',
  'image/svg+xml': 'an SVG',
};
const typeName = (type: string): string => TYPE_NAMES[type] ?? type;

/** A download name for the plan's underlay image of `type`, or null for a type it can't be. */
export function underlayFileName(planId: string, type: string): string | null {
  const ext = EXTENSIONS[type];
  return ext ? `chartroom-${planId}.${ext}` : null;
}

/** The underlay image type a file name's extension says, or null. */
export function imageTypeOfName(name: string): string | null {
  const m = /\.([a-z]+)$/i.exec(name);
  return (m && TYPE_OF_EXTENSION[m[1]!.toLowerCase()]) ?? null;
}

/** Whether `bytes` start like an image of `type`: the integration's upload check, done first. */
export function looksLike(type: string, bytes: Uint8Array): boolean {
  const starts = (sig: number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b);
  if (type === 'image/png') return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === 'image/jpeg') return starts([0xff, 0xd8, 0xff]);
  if (type === 'image/webp')
    return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
  if (type !== 'image/svg+xml') return false;
  const head = new TextDecoder('latin1')
    .decode(bytes.subarray(0, 4096))
    .replace(/^[\xef\xbb\xbf \t\r\n]+/, '')
    .toLowerCase();
  return head.startsWith('<') && head.includes('<svg');
}

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

export type PlanFileResult =
  | {
      ok: true;
      /** The plan to save to `planId`, on `floorId`. */
      plan: Plan;
      /** The image (embedded, or its own file) to upload as the underlay before saving, if any. */
      image: Blob | null;
      /** What was changed or left out on the way in. */
      notes: string[];
    }
  | { ok: false; problems: string[] };

/**
 * Read a plan file for the plan `planId` on the floor `floorId` (the plan it replaces). The plan
 * keeps the file's contents but takes this floor; its underlay comes along only with its image
 * (embedded, or the file the plan names among `files`, picked with it), or when it is already this
 * plan's own image.
 */
export async function readPlanFile(
  text: string,
  planId: string,
  floorId: string | null,
  files: readonly File[] = [],
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
  const {
    [IMAGE_KEY]: imageUrl,
    [IMAGE_FILE_KEY]: imageName,
    id: _id,
    ...rest
  } = raw as Record<string, unknown>;
  if (imageUrl != null && imageName != null)
    return fail(`the file has both ${IMAGE_KEY} and ${IMAGE_FILE_KEY}: use one`);
  let plan: Plan;
  try {
    const parsed = parsePlan(rest);
    if (parsed.problems.length > 0) return fail(...parsed.problems);
    plan = parsed.plan;
  } catch (err) {
    return fail((err as Error).message);
  }
  const problems = validatePlan(plan);
  if (problems.length > 0) return fail(...problems);

  const notes: string[] = [];
  let image: Blob | null = null;
  const picked = imageName != null ? await imageFile(imageName, files) : null;
  if (typeof picked === 'string') return fail(picked);
  if (picked && picked.file.name !== imageName)
    notes.push(
      `Took ${picked.file.name} as the underlay image ${String(imageName)}: it is the only image selected, of the same type.`,
    );
  for (const f of files)
    if (f !== picked?.file) notes.push(`Left out ${f.name}: the plan does not name it.`);
  if (picked) {
    image = picked.blob;
    if (!plan.underlay) {
      notes.push(`Left out ${picked.file.name}: the plan has no underlay to place it.`);
      image = null;
    }
  } else if (imageUrl != null) {
    image = typeof imageUrl === 'string' ? await imageBlob(imageUrl) : null;
    if (!image) return fail(`${IMAGE_KEY} is not a base64 PNG, JPEG, WebP or SVG data URL`);
    if (image.size > MAX_BYTES) return fail(`${IMAGE_KEY} is larger than 10 MB`);
    if (!plan.underlay) {
      notes.push('Left out the embedded image: the plan has no underlay to place it.');
      image = null;
    }
  } else if (plan.underlay && underlayPlanId(plan.underlay.url) !== planId) {
    notes.push(
      'Left out the underlay: its image is not in the file. Export with underlay or with underlay file to bring it along.',
    );
    plan = { ...plan, underlay: null };
  }
  return { ok: true, plan: { ...plan, floor_id: floorId }, image, notes };
}

/**
 * The image file `name` (the plan's `underlay_file`) among the picked `files`, checked like an
 * upload: an underlay type by its extension, at most 10 MB, and bytes that are that type. A
 * problem as a string otherwise. The name only picks a file the user chose; nothing is fetched.
 * Browsers rename a repeat download (`chartroom-home (1).png`), so when no file has the name but
 * exactly one image is picked, of the named file's type, that one is taken; of another type, the
 * problem says which type each is.
 */
async function imageFile(
  name: unknown,
  files: readonly File[],
): Promise<{ file: File; blob: Blob } | string> {
  const type = typeof name === 'string' && name.length <= 255 ? imageTypeOfName(name) : null;
  if (typeof name !== 'string' || !type || /[/\\]/.test(name))
    return `${IMAGE_FILE_KEY} is not a PNG, JPEG, WebP or SVG file name`;
  const images = files.filter((f) => imageTypeOfName(f.name) !== null);
  const file =
    files.find((f) => f.name === name) ??
    (images.length === 1 && imageTypeOfName(images[0]!.name) === type ? images[0] : undefined);
  if (!file) {
    if (files.length === 0)
      return `the underlay image ${name} is missing: select it together with the .json file`;
    // The only image picked, of another type: say so, rather than that it was not picked.
    const only = images.length === 1 ? images[0]! : null;
    if (only)
      return `${only.name} is ${typeName(imageTypeOfName(only.name)!)}; the plan names ${typeName(type)} (${name})`;
    return `the underlay image ${name} is not among the selected files (${files.map((f) => f.name).join(', ')})`;
  }
  if (file.size > MAX_BYTES) return `${file.name} is larger than 10 MB`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLike(type, bytes))
    return `${file.name} is not a ${EXTENSIONS[type]!.toUpperCase()} image`;
  return { file, blob: new Blob([bytes], { type }) };
}
