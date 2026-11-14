import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import { HA_URL, deletePlan, getPlan, savePlan } from './ha';
import { gridPng } from './png';

// Plan files: Export, Export with underlay and Import (replaces this plan) in the editor's
// Plan file panel. Works on two throwaway plans, never on 'example'. Their floors are not Home
// Assistant floors, so each gets a tab of its own and the floor tabs other specs use are untouched.
const SOURCE = 'e2e-plan-file-source';
const TARGET = 'e2e-plan-file-target';
const SOURCE_FLOOR = 'e2e_export_floor';
const TARGET_FLOOR = 'e2e_import_floor';
const FIXTURE = JSON.parse(
  readFileSync('frontend/test/fixtures/example-plan.json', 'utf8'),
) as Record<string, unknown>;
const token = (): string => process.env['HA_TOKEN'] ?? '';

type Json = Record<string, unknown>;
interface Underlay {
  url: string;
  width_px: number;
  height_px: number;
  scale: number;
  origin: [number, number];
  opacity: number;
}

/** A plan as the panel holds it after loading (devices filled in), so an export matches it. */
const sourcePlan = (extra: Json = {}): Json => ({
  ...FIXTURE,
  name: 'E2E plan file source',
  floor_id: SOURCE_FLOOR,
  devices: [],
  ...extra,
});

const without = (obj: Json, ...keys: string[]): Json =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

async function openEditor(page: Page, planId: string): Promise<Locator> {
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  await panel.locator(`[role=tab][data-plan="${planId}"]`).click();
  await expect(panel).toHaveAttribute('data-plan', planId);
  await expect(panel.locator('svg.plan [data-kind=wall]').first()).toBeVisible();
  return panel;
}

async function startEditing(panel: Locator): Promise<Locator> {
  await panel.locator('button.edit').click();
  await expect(panel.locator('.toolbar')).toBeVisible();
  const section = panel.locator('.inspector section[data-panel=plan-file]');
  await expect(section).toBeVisible();
  return section;
}

/** Click an export button and read the file it downloads. */
async function download(page: Page, button: Locator): Promise<{ name: string; text: string }> {
  const started = page.waitForEvent('download');
  await button.click();
  const file: Download = await started;
  return { name: file.suggestedFilename(), text: readFileSync(await file.path(), 'utf8') };
}

/** Click an export button that downloads `count` files and read them, in the order they came. */
async function downloads(
  page: Page,
  button: Locator,
  count: number,
): Promise<{ name: string; bytes: Buffer }[]> {
  const got: Download[] = [];
  const on = (d: Download): void => void got.push(d);
  page.on('download', on);
  await button.click();
  await expect.poll(() => got.length, { timeout: 10_000 }).toBe(count);
  page.off('download', on);
  return Promise.all(
    got.map(async (d) => ({ name: d.suggestedFilename(), bytes: readFileSync(await d.path()) })),
  );
}

async function importFile(section: Locator, name: string, text: string): Promise<void> {
  await section.locator('input[name=plan-file]').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
}

/** Give the source plan a 400×300 PNG underlay, uploaded as its own image. */
async function addUnderlay(): Promise<{ png: Buffer; underlay: Underlay }> {
  const png = gridPng(400, 300);
  const upload = await fetch(`${HA_URL}/api/chartroom/underlay/${SOURCE}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'image/png' },
    body: new Uint8Array(png),
  });
  expect(upload.status).toBe(200);
  const { url } = (await upload.json()) as { url: string };
  const underlay: Underlay = {
    url,
    width_px: 400,
    height_px: 300,
    scale: 0.02,
    origin: [0, 0],
    opacity: 0.6,
  };
  await savePlan(token(), SOURCE, sourcePlan({ underlay }));
  return { png, underlay };
}

/** Check the target stored the source's plan, with `png` uploaded as its own underlay image. */
async function expectImported(
  target: Locator,
  exported: Json,
  underlay: Underlay,
  png: Buffer,
): Promise<void> {
  await expect(target.locator('svg.underlay-svg .underlay image')).toHaveAttribute(
    'href',
    /^blob:/,
  );
  const stored = await savedAs(target, TARGET, exported['name'] as string);
  const storedUnderlay = stored['underlay'] as Underlay;
  expect(storedUnderlay.url).toMatch(new RegExp(`^/api/chartroom/underlay/${TARGET}\\?v=`));
  expect(without(storedUnderlay as unknown as Json, 'url')).toEqual(
    without(underlay as unknown as Json, 'url'),
  );
  expect(without(stored, 'id', 'floor_id', 'underlay')).toEqual(
    without(exported, 'floor_id', 'underlay', 'underlay_image', 'underlay_file'),
  );
  expect(stored).not.toHaveProperty('underlay_image');
  expect(stored).not.toHaveProperty('underlay_file');
  const image = await fetch(`${HA_URL}${storedUnderlay.url}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
}

/** Wait for the editor to have saved `planId` with `name`, then return the stored plan. */
async function savedAs(panel: Locator, planId: string, name: string): Promise<Json> {
  await expect
    .poll(async () => (await getPlan(token(), planId))['name'], { timeout: 10_000 })
    .toBe(name);
  await expect(panel.locator('.save-state')).toHaveText('Saved', { timeout: 10_000 });
  return getPlan(token(), planId);
}

test.describe('plan files', () => {
  test.beforeEach(async () => {
    await savePlan(token(), SOURCE, sourcePlan());
    await savePlan(token(), TARGET, {
      ...FIXTURE,
      name: 'E2E plan file target',
      floor_id: TARGET_FLOOR,
      // One wall, so it draws; the rest goes.
      walls: (FIXTURE['walls'] as unknown[]).slice(0, 1),
      doors: [],
      windows: [],
      rooms: [],
      sources: [],
      // As the panel holds it after loading, so Undo saves back exactly this.
      devices: [],
    });
  });
  test.afterEach(async () => {
    // Deleting a plan deletes its underlay image too.
    await deletePlan(token(), SOURCE);
    await deletePlan(token(), TARGET);
  });

  test('a plan is exported and imported over another plan', async ({ page }) => {
    const source = await getPlan(token(), SOURCE);
    const panel = await openEditor(page, SOURCE);
    const section = await startEditing(panel);
    // No underlay, so no button to embed one.
    await expect(section.locator('[data-action=export-plan-underlay]')).toHaveCount(0);

    // The file is the plan as stored, without its storage id.
    const file = await download(page, section.locator('[data-action=export-plan]'));
    expect(file.name).toBe(`chartroom-${SOURCE}.json`);
    const exported = JSON.parse(file.text) as Json;
    expect(exported).not.toHaveProperty('id');
    expect(exported).toEqual(without(source, 'id'));

    // Imported over the target, it keeps the target's id and floor and takes everything else.
    const before = await getPlan(token(), TARGET);
    const target = await openEditor(page, TARGET);
    const targetSection = await startEditing(target);
    await importFile(targetSection, file.name, file.text);
    await expect(targetSection.locator('[role=status]')).toContainText(`Imported ${file.name}.`);
    const lastWall = (exported['walls'] as { id: string }[]).at(-1)!.id;
    await expect(
      target.locator(`svg.plan [data-kind=wall][data-id="${lastWall}"]`).first(),
    ).toBeVisible();
    const stored = await savedAs(target, TARGET, exported['name'] as string);
    expect(stored['id']).toBe(TARGET);
    expect(stored['floor_id']).toBe(TARGET_FLOOR);
    expect(without(stored, 'id', 'floor_id')).toEqual(without(exported, 'floor_id'));

    // Undo brings the target's own plan back, all of it.
    await target.locator('[data-action=undo]').click();
    expect(await savedAs(target, TARGET, 'E2E plan file target')).toEqual(before);
  });

  test('a plan is exported with its underlay and imported with the image', async ({ page }) => {
    const { png, underlay } = await addUnderlay();

    const panel = await openEditor(page, SOURCE);
    // The export embeds the picture the panel has loaded.
    await expect(panel.locator('svg.underlay-svg .underlay image')).toHaveAttribute(
      'href',
      /^blob:/,
    );
    const section = await startEditing(panel);
    const file = await download(page, section.locator('[data-action=export-plan-underlay]'));
    const exported = JSON.parse(file.text) as Json;
    expect(exported['underlay']).toEqual(underlay);
    expect(exported['underlay_image']).toBe(`data:image/png;base64,${png.toString('base64')}`);

    const target = await openEditor(page, TARGET);
    const targetSection = await startEditing(target);
    await importFile(targetSection, file.name, file.text);
    await expect(targetSection.locator('[role=status]')).toContainText(`Imported ${file.name}.`);
    // The image is uploaded as the target's own, and the plan points at it.
    await expectImported(target, exported, underlay, png);
  });

  test('a plan exported with its underlay file is imported with the image renamed', async ({
    page,
  }) => {
    const { png, underlay } = await addUnderlay();
    const panel = await openEditor(page, SOURCE);
    // The export saves the picture the panel has loaded.
    await expect(panel.locator('svg.underlay-svg .underlay image')).toHaveAttribute(
      'href',
      /^blob:/,
    );
    const section = await startEditing(panel);
    const files = await downloads(
      page,
      section.locator('[data-action=export-plan-underlay-file]'),
      2,
    );
    const json = files.find((f) => f.name.endsWith('.json'))!;
    const picture = files.find((f) => f.name.endsWith('.png'))!;
    expect(json.name).toBe(`chartroom-${SOURCE}.json`);
    expect(picture.name).toBe(`chartroom-${SOURCE}.png`);
    expect(picture.bytes.equals(png)).toBe(true);
    const exported = JSON.parse(json.bytes.toString('utf8')) as Json;
    expect(exported['underlay']).toEqual(underlay);
    expect(exported['underlay_file']).toBe(picture.name);
    expect(exported).not.toHaveProperty('underlay_image');

    // Downloaded again, the browser renames the image; it is the only one picked, so it is taken.
    const renamed = `chartroom-${SOURCE} (1).png`;
    const target = await openEditor(page, TARGET);
    const targetSection = await startEditing(target);
    await targetSection.locator('input[name=plan-file]').setInputFiles([
      { name: json.name, mimeType: 'application/json', buffer: json.bytes },
      { name: renamed, mimeType: 'image/png', buffer: picture.bytes },
    ]);
    const status = targetSection.locator('[role=status]');
    await expect(status).toContainText(`Imported ${json.name}.`);
    await expect(status).toContainText(
      `Took ${renamed} as the underlay image ${picture.name}: it is the only image selected, of the same type.`,
    );
    await expectImported(target, exported, underlay, png);
  });

  test('a malformed file is rejected and nothing is saved', async ({ page }) => {
    const before = await getPlan(token(), TARGET);
    let saves = 0;
    page.on('websocket', (ws) =>
      ws.on('framesent', (f) => {
        if (typeof f.payload === 'string' && f.payload.includes('"chartroom/plans/save"')) saves++;
      }),
    );
    const panel = await openEditor(page, TARGET);
    const section = await startEditing(panel);
    const alert = section.locator('[role=alert]');

    await importFile(section, 'broken.json', '{"name": "Broken", "walls": ');
    await expect(alert).toContainText('broken.json was not imported:');
    await expect(alert).toContainText('not JSON');

    await importFile(
      section,
      'wrong-shape.json',
      JSON.stringify({ name: 'Wrong shape', walls: 'not a list', rooms: [{ id: 1 }] }),
    );
    await expect(alert).toContainText('wrong-shape.json was not imported:');
    await expect(alert).toContainText('walls is not a list');
    await expect(section.locator('[role=status]')).toHaveCount(0);

    // Nothing changed: no undo step, no save after the autosave delay, the stored plan as it was.
    await expect(panel.locator('[data-action=undo]')).toBeDisabled();
    await page.waitForTimeout(1500);
    await expect(panel.locator('.save-state')).toHaveText('Saved');
    expect(saves).toBe(0);
    expect(await getPlan(token(), TARGET)).toEqual(before);
  });
});
