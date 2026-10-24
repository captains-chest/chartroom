import { expect, test, type Locator, type Page } from '@playwright/test';

// The panel on a phone (the 'phone' project: a Pixel 7 viewport with touch, as in the companion
// app): controls dock in a bottom sheet under the plan, the floors stay in the header, and the
// plan pans and pinch-zooms by touch. Nothing here changes Home Assistant.
const SHOTS = process.env['SHOTS_DIR'];

async function openExample(page: Page): Promise<Locator> {
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  const tab = panel.locator('[role=tab][data-plan=example]');
  await tab.tap();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('svg.plan [data-kind=room]')).toHaveCount(5);
  return panel;
}

const viewBox = async (panel: Locator): Promise<number[]> =>
  ((await panel.locator('svg.plan').getAttribute('viewBox')) ?? '').split(' ').map(Number);

type Touch = { x: number; y: number };
/** Drive raw touch points through the browser, as a finger would. */
async function touch(page: Page, from: Touch[], to: Touch[], steps = 8): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const at = (k: number): { x: number; y: number; id: number }[] =>
    from.map((f, i) => ({
      x: f.x + ((to[i]!.x - f.x) * k) / steps,
      y: f.y + ((to[i]!.y - f.y) * k) / steps,
      id: i,
    }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= steps; k++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem('chartroom:layer')).catch(() => {});
});

test('controls dock in a bottom sheet under the plan', async ({ page }) => {
  const panel = await openExample(page);
  const vp = page.viewportSize()!;
  const sheet = panel.locator('.sheet');
  const plan = panel.locator('.plan-box');
  await expect(sheet).toBeVisible();
  const s = (await sheet.boundingBox())!;
  const p = (await plan.boundingBox())!;
  expect(s.y + s.height).toBeGreaterThan(vp.height - 2);
  expect(p.y + p.height).toBeLessThanOrEqual(s.y + 1);
  expect(s.width).toBeGreaterThan(vp.width - 2);
  // The title and footer give their room to the plan; zoom is by pinch, with Fit kept.
  await expect(panel.locator('header h1')).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Zoom in' })).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Fit plan' })).toBeVisible();

  // Layers are a tap away; the legend sits in the plan's top-left corner, inside the screen.
  await panel.getByRole('button', { name: 'Temperature' }).tap();
  const legend = panel.locator('.heat-legend');
  await expect(legend).toBeVisible();
  const l = (await legend.boundingBox())!;
  expect(l.x).toBeLessThan(vp.width / 2);
  expect(l.x + l.width).toBeLessThanOrEqual(vp.width);
  // Buttons are big enough for a finger.
  const b = (await panel.getByRole('button', { name: 'Humidity' }).boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(36);
  // Markers and value labels still fit on a small screen.
  await expect(panel.locator('svg.plan text.heat-value:not(.excluded)').first()).toBeVisible();

  // The handle opens the rest of the sheet (the underlay controls, when the plan has a drawing).
  const handle = panel.getByRole('button', { name: 'More controls' });
  await handle.tap();
  await expect(sheet).toHaveClass(/\bopen\b/);
  await handle.tap();
  await expect(sheet).not.toHaveClass(/\bopen\b/);

  // History: the bar sits in the sheet with a full-width slider.
  await panel.getByRole('button', { name: 'History' }).tap();
  const slider = panel.getByRole('slider', { name: 'Time' });
  await expect(slider).toBeEnabled();
  const r = (await slider.boundingBox())!;
  expect(r.width).toBeGreaterThan(vp.width * 0.8);
  // The plan gives up room for the bar rather than pushing it off the screen.
  expect(r.y + r.height).toBeLessThanOrEqual(vp.height);
  const live = (await panel.getByRole('button', { name: 'Live' }).boundingBox())!;
  expect(live.y + live.height).toBeLessThanOrEqual(vp.height);
  await expect(panel.getByRole('button', { name: 'Live' })).toBeVisible();
  if (SHOTS) {
    await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/phone-history.png` });
  }
  await panel.getByRole('button', { name: 'Live' }).tap();
  await expect(slider).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone.png` });
});

test('the floors switch from the header', async ({ page }) => {
  const panel = await openExample(page);
  const tabs = panel.locator('[role=tab]');
  const n = await tabs.count();
  expect(n).toBeGreaterThan(0);
  const other = tabs.and(panel.locator(':not([data-plan=example])')).first();
  if (n > 1) {
    await other.tap();
    await expect(other).toHaveAttribute('aria-selected', 'true');
    await panel.locator('[role=tab][data-plan=example]').tap();
  }
  await expect(panel.locator('[role=tab][data-plan=example]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('one finger pans and two fingers pinch-zoom the plan', async ({ page }) => {
  const panel = await openExample(page);
  const box = (await panel.locator('svg.plan').boundingBox())!;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await viewBox(panel);

  await touch(page, [{ x: c.x - 20, y: c.y }], [{ x: c.x + 60, y: c.y + 40 }]);
  await expect.poll(async () => (await viewBox(panel))[0]).toBeLessThan(before[0]!);
  const panned = await viewBox(panel);
  expect(panned[2]).toBeCloseTo(before[2]!, 5);

  await touch(
    page,
    [
      { x: c.x - 30, y: c.y },
      { x: c.x + 30, y: c.y },
    ],
    [
      { x: c.x - 120, y: c.y },
      { x: c.x + 120, y: c.y },
    ],
  );
  await expect.poll(async () => (await viewBox(panel))[2]).toBeLessThan(panned[2]! * 0.6);

  await panel.getByRole('button', { name: 'Fit plan' }).tap();
  await expect.poll(async () => (await viewBox(panel))[2]).toBeCloseTo(before[2]!, 3);
});
