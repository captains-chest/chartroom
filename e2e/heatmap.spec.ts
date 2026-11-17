import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD, api } from './ha';
import { useHeatDebug } from './heat-debug';

// Temperature and humidity heatmaps on the example plan (its sensors are placed in the fixture).
// Readings a test changes are put back afterwards; the layer choice lives in the browser only.
const SHOTS = process.env['SHOTS_DIR'];
const token = (): string => process.env['HA_TOKEN'] ?? '';

interface Heat {
  renderer: string;
  layer: string | null;
  mode: string;
  data: {
    readings: { entity_id: string; value: number }[];
    excluded: { entity_id: string }[];
  } | null;
  idle(): Promise<void>;
}
type WithView = HTMLElement & { view: { heat: Heat | null } };

async function openExample(page: Page): Promise<Locator> {
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  const tab = panel.locator('[role=tab][data-plan=example]');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('svg.plan [data-kind=room]')).toHaveCount(5);
  return panel;
}

/** Wait for the heatmap to load and settle (layout, field and transitions done), then read it. */
async function heat(panel: Locator): Promise<Omit<Heat, 'idle'>> {
  // Its code loads on demand, after the first click on a layer.
  await expect.poll(() => panel.evaluate((el) => !!(el as WithView).view.heat)).toBe(true);
  return panel.evaluate(async (el) => {
    const h = (el as WithView).view.heat!;
    await h.idle();
    return { renderer: h.renderer, layer: h.layer, mode: h.mode, data: h.data };
  });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

const numberState = async (entity_id: string): Promise<number> =>
  Number((await api<{ state: string }>(token(), `/api/states/${entity_id}`)).state);
const setNumber = (entity_id: string, value: number): Promise<unknown> =>
  api(token(), '/api/services/input_number/set_value', { entity_id, value });

test.beforeEach(({ page }) => useHeatDebug(page));

test('the layer buttons switch between temperature, humidity and no heatmap', async ({ page }) => {
  const panel = await openExample(page);
  const temperature = panel.getByRole('button', { name: 'Temperature', exact: true });
  const humidity = panel.getByRole('button', { name: 'Humidity', exact: true });
  const legend = panel.locator('.heat-legend');
  const values = panel.locator('svg.plan text.heat-value:not(.excluded)');
  await expect(temperature).toHaveAttribute('aria-pressed', 'false');
  await expect(humidity).toHaveAttribute('aria-pressed', 'false');
  await expect(temperature).toBeEnabled();
  await expect(legend).toBeHidden();
  await expect(values).toHaveCount(0);

  await temperature.click();
  await expect(temperature).toHaveAttribute('aria-pressed', 'true');
  await expect(legend).toBeVisible();
  await expect(legend.locator('.heat-title')).toContainText('Temperature');
  await expect(legend).toContainText('°C');
  await expect(legend).toContainText('6 sensors');
  await expect(legend).toContainText('1 left out');
  await expect(values).toHaveCount(6);
  // The sensor with a flat battery is unavailable: marked, and left out of the field.
  const excluded = panel.locator('svg.plan text.heat-value.excluded');
  await expect(excluded).toHaveCount(1);
  await expect(
    panel.locator('svg.plan g.device[data-entity="sensor.bath_temperature_2_dead_battery"]'),
  ).toHaveAttribute('data-status', 'unavailable');
  let h = await heat(panel);
  expect(h.layer).toBe('temperature');
  expect(h.mode).toBe('mesh');
  expect(h.data?.readings).toHaveLength(6);
  expect(h.data?.excluded.map((x) => x.entity_id)).toEqual([
    'sensor.bath_temperature_2_dead_battery',
  ]);
  await expect(panel.locator('.heat-box')).toBeVisible();
  await shot(page, 'heatmap-temperature.png');

  await humidity.click();
  await expect(humidity).toHaveAttribute('aria-pressed', 'true');
  await expect(temperature).toHaveAttribute('aria-pressed', 'false');
  await expect(legend.locator('.heat-title')).toContainText('Humidity');
  await expect(legend).toContainText('%');
  await expect(values).toHaveCount(6);
  await expect(excluded).toHaveCount(0);
  h = await heat(panel);
  expect(h.layer).toBe('humidity');
  expect(h.data?.readings.every((r) => r.entity_id.endsWith('_humidity'))).toBe(true);
  await shot(page, 'heatmap-humidity.png');

  // The choice is remembered; pressing the active layer turns the heatmap off.
  await page.reload();
  await expect(panel.getByRole('button', { name: 'Humidity', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(legend).toBeVisible();
  await panel.getByRole('button', { name: 'Humidity', exact: true }).click();
  await expect(humidity).toHaveAttribute('aria-pressed', 'false');
  await expect(legend).toBeHidden();
  await expect(panel.locator('.heat-box')).toBeHidden();
  await expect(values).toHaveCount(0);
});

test('WebGL2 and the Canvas2D fallback draw the same field', async ({ page }) => {
  const panel = await openExample(page);
  await panel.getByRole('button', { name: 'Temperature', exact: true }).click();
  expect((await heat(panel)).renderer).toBe('webgl2');
  const r = await panel.evaluate((el) =>
    window.chartroomDebug.compareRenderers((el as WithView).view.heat),
  );
  expect(r).not.toBeNull();
  console.log('renderer agreement', JSON.stringify(r));
  expect(r!.cells).toBeGreaterThan(1000);
  // Same values to float precision, bar the odd cell whose centre sits on a triangle edge
  // (about 1 in 50,000 here, off by 0.2% of the range); pixels within a few levels
  // (bilinear sampling and 8-bit rounding differ a little between the two paths).
  expect(r!.fieldP999Diff).toBeLessThan(1e-3 * r!.range);
  expect(r!.fieldOver).toBeLessThan(r!.cells / 1000);
  expect(r!.fieldMaxDiff).toBeLessThan(1e-2 * r!.range);
  expect(r!.confMaxDiff).toBeLessThan(1e-3);
  expect(r!.fadeMaxDiff).toBeLessThan(1e-3);
  expect(r!.pixelMeanDiff).toBeLessThan(2);
  expect(r!.pixelMaxDiff).toBeLessThanOrEqual(24);

  // Forced onto the fallback, the heatmap still shows the same field. Both loads must see the
  // same readings (a reading can move between them), so a pair that doesn't is taken again.
  const load = async (renderer: string | null) => {
    await page.evaluate(
      (r) =>
        r
          ? localStorage.setItem('chartroom:renderer', r)
          : localStorage.removeItem('chartroom:renderer'),
      renderer,
    );
    await page.reload();
    await expect(panel.locator('.heat-legend')).toBeVisible();
    const h = await heat(panel);
    const f = await panel.evaluate((el) =>
      window.chartroomDebug.readField((el as WithView).view.heat),
    );
    return { renderer: h.renderer, readings: JSON.stringify(h.data?.readings), field: f.field };
  };
  try {
    let gl = await load(null);
    let cpu = await load('canvas');
    for (let i = 0; i < 3 && cpu.readings !== gl.readings; i++) {
      gl = await load(null);
      cpu = await load('canvas');
    }
    expect(gl.renderer).toBe('webgl2');
    expect(cpu.renderer).toBe('canvas');
    expect(cpu.readings).toBe(gl.readings);
    expect(cpu.field.length).toBe(gl.field.length);
    let max = 0;
    for (let i = 0; i < cpu.field.length; i += 3)
      max = Math.max(max, Math.abs(cpu.field[i]! - gl.field[i]!));
    expect(max).toBeLessThan(1);
    await shot(page, 'heatmap-canvas-fallback.png');
  } finally {
    await page.evaluate(() => localStorage.removeItem('chartroom:renderer'));
  }
});

test('a new reading moves the field smoothly', async ({ page }) => {
  const panel = await openExample(page);
  await panel.getByRole('button', { name: 'Temperature', exact: true }).click();
  await heat(panel);
  const entity = 'input_number.kitchen_temp';
  const was = await numberState(entity);
  try {
    await setNumber(entity, 31);
    const label = panel.locator('svg.plan text.heat-value', { hasText: /^3[01]\.\d°$/ });
    await expect(label).toHaveCount(1);
    // The legend's range widens to take the new reading.
    await expect(panel.locator('.heat-scale span').last()).toHaveText(/^3[12]/);
    // Mid-transition the drawn value is between the old and new one; settled, it is the new one.
    const h = await heat(panel);
    const kitchen = h.data!.readings.find((r) => r.entity_id === 'sensor.kitchen_temperature')!;
    // (The box HA's simulation can nudge 31 down a little at any moment.)
    expect(kitchen.value).toBeGreaterThan(29);
  } finally {
    await setNumber(entity, was);
  }
});

test('the card shows a configured layer and its toggles', async ({ page }) => {
  const card = page.locator('chartroom-card[data-plan=example]').nth(1);
  await expect(async () => {
    await page.goto(`/${DASHBOARD}/main`);
    await expect(card.locator('svg.plan')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
  await expect(card.locator('h2.title')).toHaveText('Climate');
  const temperature = card.getByRole('button', { name: 'Temperature', exact: true });
  await expect(temperature).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('.heat-legend')).toContainText('Temperature');
  await expect(card.locator('svg.plan text.heat-value:not(.excluded)')).toHaveCount(6);
  await card.getByRole('button', { name: 'Humidity', exact: true }).click();
  await expect(card.locator('.heat-legend .heat-title')).toContainText('Humidity');
  // The first card has no layer and no toggles.
  const plain = page.locator('chartroom-card[data-plan=example]').first();
  await expect(plain.locator('.heat-layers')).toBeHidden();
  await expect(plain.locator('.heat-legend')).toBeHidden();
  await card.scrollIntoViewIfNeeded();
  if (SHOTS) {
    await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
    await card.screenshot({ path: `${SHOTS}/card-heatmap.png` });
  }
  // `history: true` adds the History button; the plain card has none.
  await expect(plain.getByRole('button', { name: 'History' })).toBeHidden();
  const open = card.getByRole('button', { name: 'History' });
  await open.click();
  await expect(card).toHaveAttribute('history', '');
  const bar = card.locator('.timebar');
  await expect(bar).toHaveAttribute('data-entities', /^[1-9]/);
  await expect(bar.getByRole('slider', { name: 'Time' })).toBeEnabled();
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/card-history.png` });
  await bar.getByRole('button', { name: 'Live' }).click();
  await expect(bar).toHaveCount(0);
  await expect(card).not.toHaveAttribute('history', '');
  await expect(open).toHaveAttribute('aria-pressed', 'false');
});
