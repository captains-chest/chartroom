import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HA_URL, deletePlan, getPlan, savePlan } from './ha';
import { gridPng } from './png';

// The editor works on its own copies of the traced example plan, never on 'example' itself.
const SHOTS = process.env['SHOTS_DIR'];
const FIXTURE = JSON.parse(readFileSync('frontend/test/fixtures/example-plan.json', 'utf8')) as {
  walls: { id: string; a: [number, number]; b: [number, number] }[];
};
const token = (): string => process.env['HA_TOKEN'] ?? '';

type Pt = [number, number];
interface PlanLike {
  name: string;
  walls: { id: string; a: Pt; b: Pt; thickness: number; material: string }[];
  rooms: { id: string; name: string; area_id?: string | null; polygon: Pt[] }[];
  doors: { id: string; wall: string }[];
  windows: { id: string; wall: string }[];
  underlay?: { url: string; scale: number; width_px: number; origin: Pt } | null;
}

const length = (w: { a: Pt; b: Pt }): number => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

const panelOf = (page: Page): Locator => page.locator('chartroom-panel');

async function openPlan(page: Page, planId: string): Promise<Locator> {
  await page.goto('/chartroom');
  const panel = panelOf(page);
  await panel.locator(`[role=tab][data-plan="${planId}"]`).click();
  await expect(panel).toHaveAttribute('data-plan', planId);
  return panel;
}

async function startEditing(panel: Locator): Promise<void> {
  await panel.locator('button.edit').click();
  await expect(panel.locator('.toolbar')).toBeVisible();
  await expect(panel.locator('.inspector')).toBeVisible();
}

/** Screen position of a point given in plan metres. */
async function toScreen(panel: Locator, p: Pt): Promise<Pt> {
  return panel.locator('svg.plan').evaluate((svg: SVGSVGElement, q: Pt) => {
    const m = svg.getScreenCTM()!;
    return [m.a * q[0] + m.c * q[1] + m.e, m.b * q[0] + m.d * q[1] + m.f] as Pt;
  }, p);
}

async function clickAt(page: Page, panel: Locator, p: Pt): Promise<void> {
  const [x, y] = await toScreen(panel, p);
  await page.mouse.click(x, y);
}

const livePlan = (panel: Locator): Promise<PlanLike> =>
  panel.evaluate((el) => (el as unknown as { plan: PlanLike }).plan);

async function saved(panel: Locator): Promise<void> {
  await expect(panel.locator('.save-state')).toHaveText('Saved', { timeout: 10_000 });
}

test.describe('plan editor', () => {
  const PLAN_ID = 'e2e-editor';
  test.beforeEach(async () => {
    await savePlan(token(), PLAN_ID, { ...FIXTURE, name: 'E2E editor', floor_id: null });
  });
  test.afterEach(async () => {
    await deletePlan(token(), PLAN_ID);
  });

  test('walls, openings and rooms are edited, undone and saved', async ({ page }) => {
    const panel = await openPlan(page, PLAN_ID);
    await expect(panel.locator('svg.plan [data-kind=wall]').first()).toBeVisible();
    await startEditing(panel);
    const inspector = panel.locator('.inspector');

    // Select an existing wall and change its material and thickness.
    await panel.locator('svg.plan [data-kind=wall][data-id=int_bedroom_2_west]').first().click();
    await expect(inspector).toHaveAttribute('data-selection', 'wall:int_bedroom_2_west');
    await inspector.locator('select[name=material]').selectOption('partition');
    await inspector.locator('input[name=thickness]').fill('12');
    await inspector.locator('input[name=thickness]').press('Enter');
    await expect
      .poll(async () => (await livePlan(panel)).walls.find((w) => w.id === 'int_bedroom_2_west'))
      .toMatchObject({ material: 'partition', thickness: 0.12 });

    // Draw a free-standing wall east of the flat (zoomed out to make room).
    const width = async (): Promise<number> =>
      Number(((await panel.locator('svg.plan').getAttribute('viewBox')) ?? '').split(' ')[2]);
    const fitted = await width();
    await panel.getByRole('button', { name: 'Zoom out' }).click();
    await expect.poll(width).toBeGreaterThan(fitted * 1.2);
    await panel.locator('[data-tool=wall]').click();
    await clickAt(page, panel, [12, 1]);
    await clickAt(page, panel, [12, 5]);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await livePlan(panel)).walls.length).toBe(17);
    const drawn = (await livePlan(panel)).walls.at(-1)!;
    expect(drawn.a).toEqual([12, 1]);
    expect(drawn.b).toEqual([12, 5]);

    // Undo and redo, by button and by keyboard.
    await panel.locator('[data-action=undo]').click();
    await expect.poll(async () => (await livePlan(panel)).walls.length).toBe(16);
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(async () => (await livePlan(panel)).walls.length).toBe(17);

    // A door and a window on the new wall.
    await panel.locator('[data-tool=door]').click();
    await clickAt(page, panel, [12, 2]);
    await expect(inspector.locator('section[data-panel=door]')).toBeVisible();
    await panel.locator('[data-tool=window]').click();
    await clickAt(page, panel, [12, 4]);
    await expect(inspector.locator('section[data-panel=window]')).toBeVisible();
    await inspector.locator('input[name=width]').fill('100');
    await inspector.locator('input[name=width]').press('Enter');

    // Drag the wall's far end: the door and window stay on it.
    await page.keyboard.press('v');
    await clickAt(page, panel, [12, 3]);
    await expect(inspector).toHaveAttribute('data-selection', `wall:${drawn.id}`);
    const [hx, hy] = await toScreen(panel, [12, 5]);
    const [tx, ty] = await toScreen(panel, [12, 6]);
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move((hx + tx) / 2, (hy + ty) / 2);
    await page.mouse.move(tx, ty);
    await page.mouse.up();
    await expect
      .poll(async () => length((await livePlan(panel)).walls.find((w) => w.id === drawn.id)!))
      .toBeCloseTo(5, 3);

    // A room east of the wall, linked to a Home Assistant area (it takes the area's name).
    await panel.locator('[data-tool=room]').click();
    for (const p of [
      [12.6, 1],
      [13.6, 1],
      [13.6, 3],
      [12.6, 3],
    ] as Pt[])
      await clickAt(page, panel, p);
    await page.keyboard.press('Enter');
    await expect(inspector.locator('section[data-panel=room]')).toBeVisible();
    await expect(inspector.locator('[data-area]')).toHaveAttribute('data-area', '2.00');
    await inspector.locator('select[name=area]').selectOption('kitchen');
    await expect(inspector.locator('input[name=name]')).toHaveValue('Kitchen');
    await page.keyboard.press('Escape');
    await shot(page, 'editor.png');

    await saved(panel);
    const stored = await getPlan<PlanLike>(token(), PLAN_ID);
    expect(stored.walls).toHaveLength(17);
    expect(stored.walls.find((w) => w.id === 'int_bedroom_2_west')).toMatchObject({
      material: 'partition',
      thickness: 0.12,
    });
    expect(stored.doors.filter((d) => d.wall === drawn.id)).toHaveLength(1);
    expect(stored.windows.filter((d) => d.wall === drawn.id)).toHaveLength(1);
    expect(stored.rooms.at(-1)).toMatchObject({ name: 'Kitchen', area_id: 'kitchen' });

    // Leaving the editor keeps the edits on screen; a reload shows them from storage.
    await panel.locator('button.edit').click();
    await expect(panel.locator('.toolbar')).toHaveCount(0);
    await page.reload();
    await panel.locator(`[role=tab][data-plan="${PLAN_ID}"]`).click();
    await expect(
      panel.locator(`svg.plan [data-kind=wall][data-id="${drawn.id}"]`).first(),
    ).toBeVisible();
  });

  test('an underlay is imported and calibrated by distance and by room area', async ({ page }) => {
    const panel = await openPlan(page, PLAN_ID);
    await startEditing(panel);
    const inspector = panel.locator('.inspector');
    const before = await livePlan(panel);
    const north = length(before.walls.find((w) => w.id === 'ext_north')!);

    await inspector.locator('input[name=underlay]').setInputFiles({
      name: 'grid.png',
      mimeType: 'image/png',
      buffer: gridPng(1200, 900),
    });
    await expect.poll(async () => (await livePlan(panel)).underlay?.width_px).toBe(1200);
    await expect(panel.locator('svg.plan .underlay image')).toHaveCount(1);
    await expect(panel.locator('svg.plan .underlay image')).toHaveAttribute('href', /^blob:/);
    const placed = (await livePlan(panel)).underlay!;
    expect(placed.url).toMatch(new RegExp(`^/api/chartroom/underlay/${PLAN_ID}\\?v=`));

    // Two-point calibration: say the measured line is twice as long as drawn.
    await panel.locator('[data-tool=measure]').click();
    await clickAt(page, panel, [1, 4]);
    await clickAt(page, panel, [5, 4]);
    const drawnText = await inspector.locator('[data-distance]').getAttribute('data-distance');
    const drawn = Number(drawnText);
    expect(drawn).toBeGreaterThan(3);
    await inspector.locator('input[name=real-distance]').fill(String(drawn * 2));
    await inspector.locator('input[name=real-distance]').press('Enter');
    await inspector.locator('[data-action=calibrate-distance]').click();
    await expect
      .poll(async () => length((await livePlan(panel)).walls.find((w) => w.id === 'ext_north')!))
      .toBeCloseTo(north * 2, 2);
    const scaled = await livePlan(panel);
    expect(scaled.underlay!.scale).toBeCloseTo(placed.scale * 2, 6);
    // Thickness is a real-world size: calibration does not change it.
    expect(scaled.walls.find((w) => w.id === 'ext_north')!.thickness).toBe(0.493);

    // Known-area calibration: put the bath back to its traced area.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await panel.locator('svg.plan [data-kind=room][data-id=bath]').click({ force: true });
    await expect(inspector).toHaveAttribute('data-selection', 'room:bath');
    const bath = before.rooms.find((r) => r.id === 'bath')!;
    const area = Math.abs(
      bath.polygon.reduce(
        (s, p, i) =>
          s +
          p[0] * bath.polygon[(i + 1) % bath.polygon.length]![1] -
          bath.polygon[(i + 1) % bath.polygon.length]![0] * p[1],
        0,
      ) / 2,
    );
    await inspector.locator('input[name=real-area]').fill(area.toFixed(3));
    await inspector.locator('input[name=real-area]').press('Enter');
    await inspector.locator('[data-action=calibrate-area]').click();
    await expect
      .poll(async () => length((await livePlan(panel)).walls.find((w) => w.id === 'ext_north')!))
      .toBeCloseTo(north, 2);
    await page.keyboard.press('Escape');
    await shot(page, 'underlay.png');

    await saved(panel);
    const stored = await getPlan<PlanLike>(token(), PLAN_ID);
    expect(stored.underlay?.width_px).toBe(1200);
    const image = await fetch(`${HA_URL}${stored.underlay!.url}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');

    // Deleting the plan deletes its image.
    await deletePlan(token(), PLAN_ID);
    const gone = await fetch(`${HA_URL}/api/chartroom/underlay/${PLAN_ID}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    expect(gone.status).toBe(404);
  });
});
