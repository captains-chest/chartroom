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
  rooms: { id: string; name: string; area_ids?: string[]; polygon: Pt[] }[];
  doors: { id: string; wall: string }[];
  windows: { id: string; wall: string }[];
  underlay?: { url: string; scale: number; width_px: number; origin: Pt } | null;
  sources: { id: string; kind: string; entity_id: string; position: Pt; area_id?: string }[];
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
    // An open-plan room links a second area and takes both names; unlinking it gives the name back.
    await inspector.locator('select[name=area]').selectOption('living_room');
    await expect(inspector.locator('input[name=name]')).toHaveValue('Kitchen & Living Room');
    await inspector.locator('[data-area-id=living_room] [data-action=unlink-area]').click();
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
    expect(stored.rooms.at(-1)).toMatchObject({ name: 'Kitchen', area_ids: ['kitchen'] });

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
    await expect(panel.locator('svg.underlay-svg .underlay image')).toHaveCount(1);
    await expect(panel.locator('svg.underlay-svg .underlay image')).toHaveAttribute(
      'href',
      /^blob:/,
    );
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
    const file = await fetch(`${HA_URL}${stored.underlay!.url}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');

    // The read-only panel shows the underlay too, with a show/hide toggle and an opacity slider.
    await panel.locator('button.edit').click();
    await expect(panel.locator('.toolbar')).toHaveCount(0);
    const image = panel.locator('svg.underlay-svg .underlay image');
    const toggle = panel.getByRole('button', { name: 'Underlay', exact: true });
    const opacity = panel.getByRole('slider', { name: 'Underlay opacity' });
    await expect(image).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await opacity.fill('0.8');
    await expect(image).toHaveAttribute('opacity', '0.8');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(image).toHaveCount(0);
    await toggle.click();
    await expect(image).toHaveCount(1);
    // The choice is the viewer's own: it survives a reload and is not saved in the plan.
    await page.reload();
    await panel.locator(`[role=tab][data-plan="${PLAN_ID}"]`).click();
    await expect(image).toHaveAttribute('opacity', '0.8');
    await expect(image).toHaveAttribute('href', /^blob:/);
    await expect(panel.locator('.plan-box')).toHaveClass(/with-underlay/);
    await shot(page, 'panel-underlay.png');
    expect((await getPlan<PlanLike>(token(), PLAN_ID)).underlay).toMatchObject({ opacity: 0.5 });

    // Deleting the plan deletes its image.
    await deletePlan(token(), PLAN_ID);
    const gone = await fetch(`${HA_URL}/api/chartroom/underlay/${PLAN_ID}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    expect(gone.status).toBe(404);
  });
});

test.describe('sources', () => {
  const PLAN_ID = 'e2e-sources';
  test.beforeEach(async () => {
    await savePlan(token(), PLAN_ID, {
      ...FIXTURE,
      name: 'E2E sources',
      floor_id: 'ground_floor',
      sources: [],
    });
  });
  test.afterEach(async () => {
    await deletePlan(token(), PLAN_ID);
  });

  test('radios and access points are placed, moved, deleted and saved', async ({ page }) => {
    const panel = await openPlan(page, PLAN_ID);
    await startEditing(panel);
    const inspector = panel.locator('.inspector');

    // A radio: any entity, its area from Home Assistant, a default level at 1 m.
    await page.keyboard.press('s');
    await expect(inspector.locator('section[data-panel=new-source]')).toBeVisible();
    const kinds = await inspector
      .locator('select[name=source-kind] option')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    // Temperature and humidity sensors are devices now (the Device tool).
    expect(kinds).toEqual(['access_point', 'radio']);
    await inspector.locator('select[name=source-kind]').selectOption('radio');
    await clickAt(page, panel, [2, 2]);
    await expect(inspector.locator('section[data-panel=source]')).toBeVisible();
    await expect(inspector.locator('input[name=tx-dbm]')).toHaveValue('-45');
    await inspector.locator('input[name=entity]').fill('sensor.hall_sensor_rssi');
    await inspector.locator('input[name=entity]').press('Enter');
    await expect(inspector.locator('[data-area]')).toHaveAttribute('data-area', 'hall');
    const radioId = (await livePlan(panel)).sources[0]!.id;

    // Drag it a metre right and down.
    const [sx, sy] = await toScreen(panel, [2, 2]);
    const [tx, ty] = await toScreen(panel, [3, 3]);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move((sx + tx) / 2, (sy + ty) / 2);
    await page.mouse.move(tx, ty);
    await page.mouse.up();
    await expect.poll(async () => (await livePlan(panel)).sources[0]!.position).toEqual([3, 3]);

    // An access point with a free-form entity and a transmit level.
    await panel.locator('[data-tool=source]').click();
    await inspector.locator('select[name=source-kind]').selectOption('access_point');
    await clickAt(page, panel, [5, 2]);
    await expect(inspector.locator('input[name=tx-dbm]')).toHaveValue('-40');
    await expect
      .poll(async () => (await livePlan(panel)).sources.map((s) => s.kind))
      .toEqual(['radio', 'access_point']);
    await expect(panel.locator('svg.plan .source.access_point')).toHaveCount(1);
    await shot(page, 'editor-sources.png');

    // Select it on the plan and delete it.
    await panel.locator('svg.plan .source.access_point').click();
    await expect(inspector).toHaveAttribute('data-selection', /^source:access_point_/);
    await inspector.locator('[data-action=delete]').click();
    await expect(panel.locator('svg.plan .source')).toHaveCount(1);

    await saved(panel);
    const stored = await getPlan<PlanLike>(token(), PLAN_ID);
    expect(stored.sources).toEqual([
      {
        id: radioId,
        kind: 'radio',
        entity_id: 'sensor.hall_sensor_rssi',
        position: [3, 3],
        area_id: 'hall',
        tx_dbm: -45,
      },
    ]);
  });

  test('a floor over the wall limit shows a warning', async ({ page }) => {
    const walls = Array.from({ length: 513 }, (_, i) => ({
      id: `w${i}`,
      a: [i * 0.02, 0],
      b: [i * 0.02, 1],
      thickness: 0.1,
      material: 'partition',
    }));
    await savePlan(token(), PLAN_ID, {
      ...FIXTURE,
      name: 'E2E sources',
      walls,
      doors: [],
      windows: [],
    });
    const panel = await openPlan(page, PLAN_ID);
    await startEditing(panel);
    await expect(panel.locator('.inspector section[data-panel=warnings]')).toContainText(
      '513 walls on this floor',
    );
  });
});

test.describe('leaving the editor', () => {
  const PLAN_ID = 'e2e-leave';
  const WALL = 'int_bedroom_2_west';
  test.beforeEach(async () => {
    await savePlan(token(), PLAN_ID, { ...FIXTURE, name: 'E2E leave', floor_id: null });
  });
  test.afterEach(async () => {
    await deletePlan(token(), PLAN_ID);
  });

  const storedMaterial = async (): Promise<string | undefined> =>
    (await getPlan<PlanLike>(token(), PLAN_ID)).walls.find((w) => w.id === WALL)?.material;

  /** Select the wall and change its material (it is a light partition in the fixture). */
  async function editWall(panel: Locator): Promise<void> {
    const inspector = panel.locator('.inspector');
    // A real click, which also gives the page the user activation a leave warning needs.
    await panel.locator(`svg.plan [data-kind=wall][data-id=${WALL}]`).first().click();
    await expect(inspector).toHaveAttribute('data-selection', `wall:${WALL}`);
    await inspector.locator('select[name=material]').selectOption('exterior');
  }

  test('an edit reloaded away before the autosave delay is still stored', async ({ page }) => {
    // A controllable clock (time runs as usual until paused), so the autosave timer can't fire
    // before the reload and the test can't pass without saving on leave.
    await page.clock.install();
    const panel = await openPlan(page, PLAN_ID);
    await startEditing(panel);
    // Far enough ahead that it is still in the future when pauseAt runs on a slow runner; the
    // autosave timer doesn't exist yet, so fast-forwarding to it can't fire a save.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 2000));
    await editWall(panel);
    // Still waiting for the 600 ms delay, which can't elapse: only saving on leave can store it.
    await expect(panel.locator('.save-state')).toHaveText('Unsaved changes');
    // The save is in flight as the page goes, so the browser may ask before leaving: leave.
    page.on('dialog', (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()));
    await page.reload();
    await page.clock.resume();

    await expect.poll(storedMaterial, { timeout: 10_000 }).toBe('exterior');
    await panel.locator(`[role=tab][data-plan="${PLAN_ID}"]`).click();
    await expect
      .poll(async () => (await livePlan(panel)).walls.find((w) => w.id === WALL)?.material)
      .toBe('exterior');
  });

  test('leaving while a save fails asks first', async ({ page }) => {
    // Answer the editor's saves with an error while `failing`; everything else goes to HA.
    let failing = true;
    await page.routeWebSocket('**/api/websocket', (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        let msg: { id?: number; type?: string } = {};
        try {
          msg = JSON.parse(String(message)) as typeof msg;
        } catch {
          // not JSON: pass it on
        }
        if (failing && msg.type === 'chartroom/plans/save')
          ws.send(
            JSON.stringify({
              id: msg.id,
              type: 'result',
              success: false,
              error: { code: 'unknown_error', message: 'Blocked by the test' },
            }),
          );
        else server.send(message);
      });
    });

    const panel = await openPlan(page, PLAN_ID);
    await startEditing(panel);
    await editWall(panel);
    const state = panel.locator('.save-state');
    // Failed saves are retried (#49), so the status goes on to say when it tries again.
    await expect(state).toHaveText(/^Save failed: Blocked by the test/, { timeout: 10_000 });

    // Closing the tab asks before leaving; staying keeps the editor and the change.
    const dialog = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    const asked = await dialog;
    expect(asked.type()).toBe('beforeunload');
    await asked.dismiss();
    expect(page.isClosed()).toBe(false);
    await expect(panel.locator('.toolbar')).toBeVisible();
    await expect(state).toHaveText(/^Save failed/);
    expect(await storedMaterial()).toBe('partition');

    // Once saving works again, Done stores the change.
    failing = false;
    await panel.locator('button.edit').click();
    await expect(panel.locator('.toolbar')).toHaveCount(0);
    await expect.poll(storedMaterial, { timeout: 10_000 }).toBe('exterior');
  });
});
