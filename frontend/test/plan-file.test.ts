import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { planIdForFloor } from '../src/model';
import { PLAN_ID_PATTERN } from '../src/plan/constants';
import { emptyPlan } from '../src/plan/functions';
import { normalizePlan } from '../src/plan/schema';
import type { Plan, Underlay } from '../src/plan/models';
import {
  dataUrl,
  imageBlob,
  imageTypeOfName,
  looksLike,
  planFileJson,
  planFileName,
  readPlanFile,
  underlayFileName,
  type PlanFileResult,
} from '../src/plan-file';
import { uploadUnderlay } from '../src/underlay';
import { underlayPath, underlayPlanId } from '../src/underlay-url';

const fixture = normalizePlan(
  JSON.parse(readFileSync(new URL('./fixtures/example-plan.json', import.meta.url), 'utf8')),
);

const PLAN_ID = 'floor_ground';
const underlay = (url: string): Underlay => ({
  url,
  width_px: 200,
  height_px: 100,
  scale: 0.05,
  origin: [1, 2],
  opacity: 0.4,
});
/** A tiny PNG's bytes (only the signature matters here). */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);

const read = (
  text: string,
  floorId: string | null = 'ground',
  files: File[] = [],
): Promise<PlanFileResult> => readPlanFile(text, PLAN_ID, floorId, files);
const pngFile = (name = 'chartroom-floor_ground.png', bytes: Uint8Array<ArrayBuffer> = PNG): File =>
  new File([bytes], name, { type: 'image/png' });
const ok = async (r: Promise<PlanFileResult>): Promise<Extract<PlanFileResult, { ok: true }>> => {
  const res = await r;
  if (!res.ok) throw new Error(`rejected: ${res.problems.join('; ')}`);
  return res;
};
const problems = async (r: Promise<PlanFileResult>): Promise<string[]> => {
  const res = await r;
  return res.ok ? [] : res.problems;
};
const withKeys = (extra: Record<string, unknown>): string =>
  JSON.stringify({ ...emptyPlan('X'), ...extra });

describe('plan export', () => {
  it('writes the plan as stored, without its storage id', async () => {
    const text = planFileJson({ ...fixture, id: 'floor_ground' } as Plan);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "walls": [');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('underlay_image');
    expect(parsed).toEqual(JSON.parse(JSON.stringify(fixture)));
  });

  it('embeds the image only when the plan has an underlay', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    expect(JSON.parse(planFileJson(fixture, image))).not.toHaveProperty('underlay_image');
    const plan = { ...fixture, underlay: underlay(underlayPath(PLAN_ID)) };
    expect(JSON.parse(planFileJson(plan, image))).toMatchObject({ underlay_image: image });
  });

  it('names the file after the plan id', async () => {
    expect(planFileName(PLAN_ID)).toBe('chartroom-floor_ground.json');
  });

  it('encodes and decodes the image as a data URL byte for byte', async () => {
    const url = await dataUrl(new Blob([PNG], { type: 'image/png' }));
    expect(url).toMatch(/^data:image\/png;base64,/);
    const back = (await imageBlob(url))!;
    expect(back.type).toBe('image/png');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(PNG);
  });
});

describe('plan import', () => {
  it('round-trips the example plan onto this floor', async () => {
    const r = await ok(read(planFileJson(fixture)));
    expect(r.plan).toEqual({ ...fixture, floor_id: 'ground' });
    expect(r.image).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it('round-trips an embedded underlay image', async () => {
    const plan = { ...fixture, underlay: underlay('/api/chartroom/underlay/other?v=abc123') };
    const image = await dataUrl(new Blob([PNG], { type: 'image/png' }));
    const r = await ok(read(planFileJson(plan, image)));
    expect(r.plan.underlay).toEqual(plan.underlay);
    expect(new Uint8Array(await r.image!.arrayBuffer())).toEqual(PNG);
  });

  it("keeps the underlay when it is this plan's own image", async () => {
    const own = underlay(`${underlayPath(PLAN_ID)}?v=0123456789ab`);
    const r = await ok(read(planFileJson({ ...fixture, underlay: own })));
    expect(r.plan.underlay).toEqual(own);
    expect(r.notes).toEqual([]);
  });

  it('leaves out an underlay whose image is elsewhere, so it is never fetched', async () => {
    for (const url of [
      underlayPath('another_plan'),
      'https://example.com/steal-my-token.png',
      '//example.com/x.png',
      '/api/chartroom/underlay/floor_ground/../../auth',
      `/api/chartroom/underlay/${PLAN_ID}?v=1&x=https://example.com`,
    ]) {
      const r = await ok(read(planFileJson({ ...fixture, underlay: underlay(url) })));
      expect(r.plan.underlay, url).toBeNull();
      expect(r.notes, url).toEqual([
        'Left out the underlay: its image is not in the file. Export with underlay or with underlay file to bring it along.',
      ]);
    }
  });

  it('takes the floor it is imported to, drops the storage id and keeps other keys', async () => {
    const r = await ok(
      read(withKeys({ id: 'old', floor_id: 'attic', meta: { by: 'trace.mjs' } }), null),
    );
    expect(r.plan.floor_id).toBeNull();
    expect(r.plan).not.toHaveProperty('id');
    expect(r.plan).toMatchObject({ meta: { by: 'trace.mjs' } });
    expect(r.notes).toEqual([]);
  });

  it('fills in missing lists, as for a stored plan', async () => {
    const r = await ok(read('{"name": "Bare"}'));
    expect(r.plan).toMatchObject({ name: 'Bare', walls: [], devices: [], schema_version: 2 });
  });

  it('drops an embedded image with nothing to place it', async () => {
    const r = await ok(read(withKeys({ underlay_image: 'data:image/png;base64,iVBORw0KGgo=' })));
    expect(r.image).toBeNull();
    expect(r.notes.join(' ')).toMatch(/no underlay/);
  });
});

describe('plan import rejects', () => {
  it('text that is not a plan object', async () => {
    expect((await problems(read('not json')))[0]).toMatch(/^not JSON/);
    for (const text of ['[]', 'null', '42', '"plan"'])
      expect(await problems(read(text)), text).toEqual([
        'not a Chartroom plan: expected a JSON object',
      ]);
  });

  it('a schema version this build does not know', async () => {
    expect(await problems(read(withKeys({ schema_version: 3 })))).toEqual([
      'unsupported schema_version 3',
    ]);
  });

  it('lists and fields of the wrong type', async () => {
    expect(await problems(read(withKeys({ walls: 'none', outline: [[0, 'x']] })))).toEqual([
      'outline is not a list of points',
      'walls is not a list',
    ]);
    const wall = { id: 'w', a: [0, 0], b: [1, 0], thickness: 0.1, material: 'exterior' };
    expect(
      await problems(
        read(withKeys({ walls: [wall, { ...wall, id: 'v', a: [0], thickness: '1' }, 7] })),
      ),
    ).toEqual([
      'walls[1]: bad or missing a',
      'walls[1]: bad or missing thickness',
      'walls[2] is not an object',
    ]);
    expect(await problems(read(withKeys({ sources: [{ id: 's', kind: 'laser' }] })))).toEqual([
      'sources[0]: bad or missing kind',
      'sources[0]: bad or missing entity_id',
      'sources[0]: bad or missing position',
    ]);
    expect(
      await problems(
        read(withKeys({ underlay: { ...underlay(underlayPath(PLAN_ID)), opacity: 3 } })),
      ),
    ).toEqual(['underlay: bad or missing opacity']);
  });

  it('a plan that fails validation', async () => {
    const wall = { id: 'Wall 1', a: [0, 0], b: [0, 0], thickness: 0.1, material: 'unobtainium' };
    expect(await problems(read(withKeys({ walls: [wall], outline: [] })))).toEqual([
      'wall id Wall 1 is not [a-z0-9_-]',
      'wall Wall 1: unknown material unobtainium',
      'wall Wall 1 has zero length',
      'outline has fewer than 3 corners',
    ]);
  });

  it('an embedded image that is not an underlay image', async () => {
    const plan = { ...fixture, underlay: underlay(underlayPath(PLAN_ID)) };
    for (const image of [
      'data:image/png;base64,A',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png;base64,***',
      'data:image/png,raw',
      'https://example.com/a.png',
    ])
      expect((await problems(read(planFileJson(plan, image))))[0], image).toMatch(
        /underlay_image is not/,
      );
    expect(await problems(read(JSON.stringify({ ...plan, underlay_image: 7 })))).toEqual([
      'underlay_image is not a base64 PNG, JPEG, WebP or SVG data URL',
    ]);
  });
});

describe('underlay as a separate file', () => {
  const plan = { ...fixture, underlay: underlay(`${underlayPath(PLAN_ID)}?v=abc123`) };
  const name = underlayFileName(PLAN_ID, 'image/png')!;
  const text = planFileJson(plan, { file: name });

  it('exports the placement in the plan and names the image file', async () => {
    expect(name).toBe('chartroom-floor_ground.png');
    expect(underlayFileName(PLAN_ID, 'image/jpeg')).toBe('chartroom-floor_ground.jpg');
    expect(underlayFileName(PLAN_ID, 'image/svg+xml')).toBe('chartroom-floor_ground.svg');
    expect(underlayFileName(PLAN_ID, 'text/html')).toBeNull();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ underlay: plan.underlay, underlay_file: name });
    expect(parsed).not.toHaveProperty('underlay_image');
    expect(JSON.parse(planFileJson(fixture, { file: name }))).not.toHaveProperty('underlay_file');
  });

  it('round-trips the placement and the image bytes', async () => {
    const r = await ok(read(text, 'ground', [pngFile()]));
    expect(r.plan).toEqual({ ...plan, floor_id: 'ground' });
    expect(r.image!.type).toBe('image/png');
    expect(new Uint8Array(await r.image!.arrayBuffer())).toEqual(PNG);
    expect(r.notes).toEqual([]);
  });

  it('takes the type from the name, not what the browser guessed', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    const file = new File([jpeg], 'plan.JPEG', { type: '' });
    const r = await ok(read(planFileJson(plan, { file: 'plan.JPEG' }), 'ground', [file]));
    expect(r.image!.type).toBe('image/jpeg');
  });

  it('notes picked files the plan does not name, and an image with nothing to place it', async () => {
    const r = await ok(read(text, 'ground', [pngFile(), pngFile('other.png')]));
    expect(r.notes).toEqual(['Left out other.png: the plan does not name it.']);
    const bare = await ok(
      read(withKeys({ underlay_file: name }), 'ground', [pngFile(), pngFile('x.png')]),
    );
    expect(bare.image).toBeNull();
    expect(bare.notes).toEqual([
      'Left out x.png: the plan does not name it.',
      `Left out ${name}: the plan has no underlay to place it.`,
    ]);
    const embedded = await ok(read(planFileJson(fixture), 'ground', [pngFile()]));
    expect(embedded.notes).toEqual([`Left out ${name}: the plan does not name it.`]);
  });

  it('rejects a missing image', async () => {
    expect(await problems(read(text))).toEqual([
      `the underlay image ${name} is missing: select it together with the .json file`,
    ]);
  });

  it('takes the only image picked when the browser renamed it, with a note', async () => {
    const renamed = 'chartroom-floor_ground (1).png';
    const took = `Took ${renamed} as the underlay image ${name}: it is the only image selected, of the same type.`;
    const r = await ok(read(text, 'ground', [pngFile(renamed)]));
    expect(r.plan).toEqual({ ...plan, floor_id: 'ground' });
    expect(r.image!.type).toBe('image/png');
    expect(new Uint8Array(await r.image!.arrayBuffer())).toEqual(PNG);
    expect(r.notes).toEqual([took]);
    // A picked file that is not an image does not count against "only one".
    const txt = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    const withText = await ok(read(text, 'ground', [txt, pngFile(renamed)]));
    expect(withText.notes).toEqual([took, 'Left out notes.txt: the plan does not name it.']);
  });

  it('checks a renamed image like any other', async () => {
    const renamed = 'chartroom-floor_ground (1).png';
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    expect(await problems(read(text, 'ground', [pngFile(renamed, html)]))).toEqual([
      `${renamed} is not a PNG image`,
    ]);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(await problems(read(text, 'ground', [pngFile(renamed, big)]))).toEqual([
      `${renamed} is larger than 10 MB`,
    ]);
  });

  it('rejects several images when none has the name', async () => {
    const one = 'chartroom-floor_ground (1).png';
    const two = 'chartroom-floor_ground (2).png';
    expect(await problems(read(text, 'ground', [pngFile(one), pngFile(two)]))).toEqual([
      `the underlay image ${name} is not among the selected files (${one}, ${two})`,
    ]);
  });

  it('rejects the only image picked when its type is not the named one, saying why', async () => {
    const jpg = 'chartroom-floor_ground.jpg';
    const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], jpg, { type: 'image/jpeg' });
    expect(await problems(read(text, 'ground', [jpeg]))).toEqual([
      `${jpg} is a JPEG; the plan names a PNG (${name})`,
    ]);
    // The type is the extension's, not what the browser guessed.
    const webp = 'chartroom-floor_ground (1).webp';
    expect(await problems(read(text, 'ground', [pngFile(webp)]))).toEqual([
      `${webp} is a WebP; the plan names a PNG (${name})`,
    ]);
    // Other picked files that are not images do not change it.
    const txt = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    expect(await problems(read(text, 'ground', [txt, jpeg]))).toEqual([
      `${jpg} is a JPEG; the plan names a PNG (${name})`,
    ]);
    // The other way round, and with "an".
    const svgName = underlayFileName(PLAN_ID, 'image/svg+xml')!;
    const svgText = planFileJson(plan, { file: svgName });
    expect(await problems(read(svgText, 'ground', [pngFile()]))).toEqual([
      `${name} is a PNG; the plan names an SVG (${svgName})`,
    ]);
  });

  it('says an image is not among the selected files when none of them is an image', async () => {
    const txt = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    expect(await problems(read(text, 'ground', [txt]))).toEqual([
      `the underlay image ${name} is not among the selected files (notes.txt)`,
    ]);
  });

  it('rejects an image whose bytes are not its type, or that is too large', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    expect(await problems(read(text, 'ground', [pngFile(name, html)]))).toEqual([
      `${name} is not a PNG image`,
    ]);
    expect(await problems(read(text, 'ground', [pngFile(name, new Uint8Array())]))).toEqual([
      `${name} is not a PNG image`,
    ]);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(await problems(read(text, 'ground', [pngFile(name, big)]))).toEqual([
      `${name} is larger than 10 MB`,
    ]);
  });

  it('rejects a name that is not an image file name, or both ways at once', async () => {
    for (const bad of ['plan.html', 'noext', '../x.png', 'a\\b.png', 7, 'x'.repeat(260) + '.png'])
      expect(
        await problems(
          read(JSON.stringify({ ...plan, underlay_file: bad }), 'ground', [pngFile()]),
        ),
        String(bad),
      ).toEqual(['underlay_file is not a PNG, JPEG, WebP or SVG file name']);
    const image = await dataUrl(new Blob([PNG], { type: 'image/png' }));
    expect(
      await problems(read(JSON.stringify({ ...plan, underlay_image: image, underlay_file: name }))),
    ).toEqual(['the file has both underlay_image and underlay_file: use one']);
  });

  it('checks bytes as the integration does', async () => {
    const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
    expect(looksLike('image/png', PNG)).toBe(true);
    expect(looksLike('image/jpeg', PNG)).toBe(false);
    expect(looksLike('image/webp', enc('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(looksLike('image/webp', enc('RIFF\0\0\0\0WAVE'))).toBe(false);
    expect(looksLike('image/svg+xml', enc('\uFEFF\n <?xml version="1.0"?><SVG>'))).toBe(true);
    expect(looksLike('image/svg+xml', enc('<html><body>'))).toBe(false);
    expect(looksLike('text/html', enc('<svg>'))).toBe(false);
    expect(imageTypeOfName('a.Webp')).toBe('image/webp');
    expect(imageTypeOfName('a.gif')).toBeNull();
  });
});

describe('plan id pattern', () => {
  it('matches the integration: [a-z0-9_-], 1 to 64 long, no trailing newline', async () => {
    for (const id of ['a', 'floor_ground', 'x'.repeat(64), planIdForFloor('Ground Floor!')])
      expect(PLAN_ID_PATTERN.test(id), id).toBe(true);
    for (const id of ['', 'up\n', 'Up', 'a/b', '../x', 'x'.repeat(65)])
      expect(PLAN_ID_PATTERN.test(id), JSON.stringify(id)).toBe(false);
  });

  it("reads the plan id from an underlay URL, and nothing else's", async () => {
    expect(underlayPlanId(underlayPath(PLAN_ID))).toBe(PLAN_ID);
    expect(underlayPlanId(`${underlayPath(PLAN_ID)}?v=0123456789ab`)).toBe(PLAN_ID);
    for (const url of [
      '/api/chartroom/underlay/',
      '/api/chartroom/underlay/up\n',
      '/api/chartroom/underlay/up%0A',
      '/api/chartroom/underlay/a/b',
      `/api/chartroom/underlay/${'x'.repeat(65)}`,
      'https://example.com/api/chartroom/underlay/a',
    ])
      expect(underlayPlanId(url), JSON.stringify(url)).toBeNull();
  });
});

describe('uploadUnderlay', () => {
  it("posts the image to the plan's path and returns its URL", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const hass: Hass = {
      states: {},
      fetchWithAuth: async (path, init) => {
        calls.push([path, init]);
        return Response.json({ url: `${path}?v=abc` });
      },
    };
    const blob = new Blob([PNG], { type: 'image/png' });
    expect(await uploadUnderlay(hass, PLAN_ID, blob)).toBe(`${underlayPath(PLAN_ID)}?v=abc`);
    expect(calls[0]![1]).toMatchObject({ method: 'POST', body: blob });
    await expect(uploadUnderlay(undefined, PLAN_ID, blob)).rejects.toThrow('not connected');
  });
});
