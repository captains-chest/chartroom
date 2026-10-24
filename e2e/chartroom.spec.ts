import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD } from './ha';

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
  await expect(panel.locator('.floors')).toBeVisible();
  // The sidebar entry registered by the integration.
  await expect(page.locator('ha-sidebar').getByText('Chartroom', { exact: true })).toBeVisible();
  if (SHOTS) await shot(page, { path: `${SHOTS}/panel.png` });
});

test('the Chartroom card renders on a dashboard', async ({ page }) => {
  const card = page.locator('chartroom-card');
  // On a cold start the dashboard can render before the card module has loaded and show a
  // configuration error; Home Assistant recovers on reload, so allow a few.
  await expect(async () => {
    await page.goto(`/${DASHBOARD}/main`);
    await page.waitForFunction(() => customElements.get('chartroom-card') !== undefined);
    await expect(card.locator('svg.plan')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  await expect(card.locator('h2.title')).toHaveText('Chartroom');
  await expect(card.locator('.floors')).toBeVisible();
  if (SHOTS) await shot(page, { path: `${SHOTS}/card.png` });
});
