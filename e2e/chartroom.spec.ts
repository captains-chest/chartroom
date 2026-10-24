import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD, FLOORS, deletePlan, getPlan, planCommand } from './ha';

const SHOTS = process.env['SHOTS_DIR'];

/** Screenshot once Home Assistant's launch screen has faded out. */
async function shot(page: Page, options: { path: string }): Promise<void> {
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
  await page.screenshot(options);
}

test('the Chartroom panel renders in the sidebar and talks to the integration', async ({
  page,
}) => {
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  await expect(panel.locator('svg.plan')).toBeVisible();
  await expect(panel.locator('h1')).toHaveText('Chartroom');
  await expect(panel.locator('.status')).toContainText('saved plan(s)');
  await expect(panel.locator('.status')).toContainText('worker 0 ready');
  // The sidebar entry registered by the integration.
  await expect(page.locator('ha-sidebar').getByText('Chartroom', { exact: true })).toBeVisible();
});

test('the panel switches floors and shows a plan with pan and zoom', async ({ page }) => {
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  const tabs = panel.locator('nav.tabs [role=tab]');
  // One tab per Home Assistant floor, then plans that belong to no floor (the example plan).
  for (const f of FLOORS) await expect(tabs.filter({ hasText: f.name })).toHaveCount(1);
  const example = panel.locator('[role=tab][data-plan=example]');
  await example.click();
  await expect(example).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('data-plan', 'example');
  await expect(panel.locator('svg.plan [data-kind=wall]').first()).toBeVisible();
  await expect(panel.locator('svg.plan [data-kind=room]')).toHaveCount(5);
  await expect(panel.locator('svg.plan [data-kind=door]')).toHaveCount(4);
  await expect(panel.locator('svg.plan text').filter({ hasText: 'Kitchen-living' })).toHaveCount(1);
  if (SHOTS) await shot(page, { path: `${SHOTS}/panel.png` });

  // Zoom buttons, wheel zoom and drag-to-pan all move the view box.
  const svg = panel.locator('svg.plan');
  const box = async (): Promise<number[]> =>
    ((await svg.getAttribute('viewBox')) ?? '').split(' ').map(Number);
  const fitted = await box();
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = await box();
  expect(zoomed[2]!).toBeLessThan(fitted[2]! * 0.8);
  const r = (await svg.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await box())[2]!).toBeGreaterThan(zoomed[2]!);
  const before = await box();
  // Pan from a spot outside the flat (the view margin) so no element is grabbed.
  await page.mouse.move(r.x + 8, r.y + 8);
  await page.mouse.down();
  await page.mouse.move(r.x + 108, r.y + 58, { steps: 4 });
  await page.mouse.up();
  const panned = await box();
  expect(panned[0]!).toBeLessThan(before[0]!);
  expect(panned[2]!).toBeCloseTo(before[2]!, 6);
  await panel.getByRole('button', { name: 'Fit plan' }).click();
  expect((await box())[2]!).toBeCloseTo(fitted[2]!, 3);

  // A floor without a plan offers to create one.
  const ground = tabs.filter({ hasText: 'Ground floor' });
  const groundPlan = await ground.getAttribute('data-plan');
  await ground.click();
  await expect(ground).toHaveAttribute('aria-selected', 'true');
  if (!groundPlan) {
    await expect(panel.locator('.empty')).toContainText('No plan for Ground floor yet.');
    await expect(panel.locator('.empty button.create')).toBeVisible();
  }
  // The chosen tab survives a reload.
  await page.reload();
  await expect(panel.locator('[role=tab][aria-selected=true]')).toHaveText('Ground floor');
});

test('creating a plan for an empty floor opens the editor on it', async ({ page }) => {
  const id = 'floor_first_floor';
  const { plans } = await planCommand<{ plans: { id: string; floor_id: string | null }[] }>(
    process.env['HA_TOKEN'] ?? '',
    { type: 'chartroom/plans/list' },
  );
  test.skip(
    plans.some((p) => p.id === id || p.floor_id === 'first_floor'),
    'the first floor already has a plan on this instance; leave it alone',
  );
  try {
    await page.goto('/chartroom');
    const panel = page.locator('chartroom-panel');
    await panel.locator('[role=tab]').filter({ hasText: 'First floor' }).click();
    await panel.locator('.empty button.create').click();
    await expect(panel.locator('.toolbar')).toBeVisible();
    await expect(panel.locator('[data-tool=wall]')).toBeVisible();
    await expect(panel).toHaveAttribute('data-plan', id);
    const stored = await getPlan<{ name: string; floor_id: string; walls: unknown[] }>(
      process.env['HA_TOKEN'] ?? '',
      id,
    );
    expect(stored).toMatchObject({ name: 'First floor', floor_id: 'first_floor', walls: [] });
  } finally {
    await deletePlan(process.env['HA_TOKEN'] ?? '', id);
  }
});

test('the Chartroom card renders on a dashboard', async ({ page }) => {
  const card = page.locator('chartroom-card[data-plan=example]');
  // On a cold start the first page load can miss the card module (it is added to the frontend's
  // extra modules when the config entry loads) and show a configuration error; a reload picks
  // it up. Each attempt is bounded so the loop really does reload.
  await expect(async () => {
    await page.goto(`/${DASHBOARD}/main`);
    await page.waitForFunction(() => customElements.get('chartroom-card') !== undefined, null, {
      timeout: 10_000,
    });
    await expect(card.locator('svg.plan')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
  await expect(card.locator('h2.title')).toHaveText('Chartroom');
  await expect(card.locator('svg.plan [data-kind=room]')).toHaveCount(5);
});
