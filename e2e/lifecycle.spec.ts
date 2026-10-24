import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD } from './ha';

// Home Assistant detaches and re-attaches cards and panels (edit mode, view switches,
// navigation). A re-attached one must work as before; a removed one must stop its work.
// Nothing here changes Home Assistant.
const MESH_REFRESH_MS = 60_000;

interface Heat {
  data: { readings: unknown[] } | null;
  idle(): Promise<void>;
}
interface View {
  heat: Heat | null;
  mesh: { links: unknown[] } | null;
}
type WithView = HTMLElement & { view: View };
type TestWindow = Window & { chartroomTestCard?: WithView };

/** Count the chartroom/mesh/get requests the page sends. */
function countMeshRequests(page: Page): () => number {
  let n = 0;
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"chartroom/mesh/get"')) n++;
    }),
  );
  return () => n;
}

/** Wait for the heatmap to settle and return how many readings it shows. */
const readings = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const heat = (window as TestWindow).chartroomTestCard?.view.heat;
    if (!heat) return -1;
    await heat.idle();
    return heat.data?.readings.length ?? 0;
  });

test('a re-attached card still draws its layers, and a removed one stops polling', async ({
  page,
}) => {
  await page.clock.install();
  const meshRequests = countMeshRequests(page);
  await expect(async () => {
    await page.goto(`/${DASHBOARD}/main`);
    await page.waitForFunction(() => customElements.get('chartroom-card') !== undefined, null, {
      timeout: 10_000,
    });
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
  await page.evaluate(() => {
    const card = document.createElement('chartroom-card') as unknown as WithView & {
      setConfig(c: unknown): void;
      hass: unknown;
    };
    card.setConfig({
      type: 'custom:chartroom-card',
      plan_id: 'example',
      layer: 'temperature',
      mesh: true,
    });
    card.hass = (document.querySelector('home-assistant') as unknown as { hass: unknown }).hass;
    card.setAttribute(
      'style',
      'position:fixed;inset:0 auto auto 0;width:480px;height:360px;z-index:9',
    );
    document.body.append(card);
    (window as TestWindow).chartroomTestCard = card;
  });
  const card = page.locator('body > chartroom-card');
  await expect(card.locator('svg.plan [data-kind=room]')).toHaveCount(5);
  await expect.poll(() => readings(page)).toBeGreaterThan(0);
  await expect(card.locator('.mesh-note')).toBeVisible();
  await expect.poll(meshRequests).toBeGreaterThan(0);

  // Detached and re-attached, as Lovelace does when cards move: everything comes back.
  await page.evaluate(() => {
    const el = (window as TestWindow).chartroomTestCard!;
    el.remove();
    document.body.append(el);
  });
  await expect.poll(() => readings(page)).toBeGreaterThan(0);
  await expect(card.locator('.heat-box canvas')).toHaveCount(1);
  await expect(card.locator('.heat-legend')).toBeVisible();
  await expect(card.locator('.mesh-note')).toBeVisible();
  await expect(card.locator('svg.plan [data-kind=room]')).toHaveCount(5);

  // While attached the mesh is read again every minute.
  const before = meshRequests();
  await page.clock.fastForward(MESH_REFRESH_MS + 1000);
  await expect.poll(meshRequests).toBeGreaterThan(before);

  // Removed for good: no more requests.
  await page.evaluate(() => (window as TestWindow).chartroomTestCard!.remove());
  const removed = meshRequests();
  await page.clock.fastForward(MESH_REFRESH_MS + 1000);
  await page.clock.fastForward(MESH_REFRESH_MS + 1000);
  await page.waitForTimeout(500);
  expect(meshRequests()).toBe(removed);
});

test('a re-attached panel still draws its heatmap and mesh', async ({ page }) => {
  try {
    await page.goto('/chartroom');
    const panel = page.locator('chartroom-panel');
    await panel.locator('[role=tab][data-plan=example]').click();
    await expect(panel.locator('svg.plan [data-kind=room]')).toHaveCount(5);
    await panel.getByRole('button', { name: 'Temperature' }).click();
    await panel.getByRole('button', { name: 'Mesh' }).click();
    const settled = (): Promise<number> =>
      panel.evaluate(async (el) => {
        const heat = (el as WithView).view.heat;
        if (!heat) return -1;
        await heat.idle();
        return heat.data?.readings.length ?? 0;
      });
    await expect.poll(settled).toBeGreaterThan(0);
    await panel.evaluate((el) => {
      const parent = el.parentNode!;
      const next = el.nextSibling;
      el.remove();
      parent.insertBefore(el, next);
    });
    await expect.poll(settled).toBeGreaterThan(0);
    await expect(panel.locator('.heat-box canvas')).toHaveCount(1);
    await expect(panel.locator('.heat-legend')).toBeVisible();
    await expect(panel.locator('.mesh-note')).toBeVisible();
  } finally {
    await page
      .evaluate(() => {
        localStorage.removeItem('chartroom:layer');
        localStorage.removeItem('chartroom:mesh');
      })
      .catch(() => {});
  }
});
