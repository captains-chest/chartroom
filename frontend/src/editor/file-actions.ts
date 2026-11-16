// Plan files in the editor: what an export downloads, and reading an import (and uploading its
// image) up to the plan to commit. Over plan-file.ts, which reads and writes the file itself.
import type { Plan } from '../plan/models';
import {
  dataUrl,
  MAX_FILE_BYTES,
  planFileJson,
  planFileName,
  readPlanFile,
  underlayFileName,
} from '../plan-file';
import { h } from '../ui';

/** Export the plan alone, with its underlay image embedded, or with the image as its own file. */
export type ExportMode = 'none' | 'embed' | 'file';

/**
 * The files an export of plan `planId` downloads: the .json, and the image when `mode` is
 * `file`. `image` is the plan's underlay image when it is loaded. Throws saying why it can't.
 */
export async function exportFiles(
  plan: Plan,
  planId: string,
  image: Blob | null,
  mode: ExportMode,
): Promise<{ blob: Blob; name: string }[]> {
  if (mode === 'none') image = null;
  else if (!image) throw new Error('the underlay image is not loaded');
  let imageName: string | null = null;
  if (image && mode === 'file') {
    imageName = underlayFileName(planId, image.type);
    if (!imageName) throw new Error(`the underlay image is ${image.type || 'of no type'}`);
  }
  const embedded = image && !imageName ? await dataUrl(image) : null;
  const json = planFileJson(plan, imageName ? { file: imageName } : embedded);
  const files = [
    { blob: new Blob([json], { type: 'application/json' }), name: planFileName(planId) },
  ];
  if (image && imageName) files.push({ blob: image, name: imageName });
  return files;
}

/** Save `blob` as a download named `name`. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url));
}

export type ImportResult =
  | {
      ok: true;
      file: File;
      /** The plan to commit, its underlay pointing at the uploaded image. */
      plan: Plan;
      /** The image uploaded with it, to show without fetching it back. */
      image: { url: string; blob: Blob } | null;
      notes: string[];
    }
  | { ok: false; lines: string[] };

/**
 * Read the picked `files` as a plan import over plan `planId` on `floorId`: one .json plan file,
 * and its image file if it names one. Its image is stored with `upload`. Null when `closed()` says
 * the editor went meanwhile (nothing to show the result in).
 */
export async function readImport(
  files: readonly File[],
  planId: string,
  floorId: string | null,
  upload: (image: Blob) => Promise<string>,
  closed: () => boolean,
): Promise<ImportResult | null> {
  const fail = (...lines: string[]): ImportResult => ({ ok: false, lines });
  const plans = files.filter((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
  if (plans.length !== 1)
    return fail(`Select one .json plan file (with its underlay image, if it has one).`);
  const file = plans[0]!;
  if (file.size > MAX_FILE_BYTES) return fail(`${file.name}: the file is larger than 16 MB`);
  const r = await readPlanFile(
    await file.text(),
    planId,
    floorId,
    files.filter((f) => f !== file),
  );
  if (closed()) return null;
  if (!r.ok) return fail(`${file.name} was not imported:`, ...r.problems);
  let plan = r.plan;
  let image: { url: string; blob: Blob } | null = null;
  if (r.image && plan.underlay) {
    try {
      const url = await upload(r.image);
      plan = { ...plan, underlay: { ...plan.underlay, url } };
      image = { url, blob: r.image };
    } catch (err) {
      return fail(`${file.name} was not imported: ${(err as Error).message ?? err}`);
    }
  }
  if (closed()) return null;
  return { ok: true, file, plan, image, notes: r.notes };
}
