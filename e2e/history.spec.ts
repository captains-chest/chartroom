import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD, api, deletePlan, savePlan } from './ha';

// The history slider on a throwaway copy of the example plan with the kitchen window sensor as a
// device. The test records a kitchen reading and a window state, moves on, then scrubs back to
// them. The plan is deleted afterwards and the reading and window put back.
const SHOTS = process.env['SHOTS_DIR'];
const PLAN = 'e2e-history';
const token = (): string => process.env['HA_TOKEN'] ?? '';
const FIXTURE = JSON.parse(readFileSync('frontend/test/fixtures/example-plan.json', 'utf8'));
const TEMP = 'input_number.kitchen_temp';
const WINDOW = 'input_boolean.kitchen_window';

interface Heat {
  idle(): Promise<void>;
  data: { readings: { entity_id: string; value: number }[] } | null;
}
type WithView = HTMLElement & { view: { heat: Heat | null } };

const state = async (entity_id: string): Promise<string> =>
  (await api<{ state: string }>(token(), `/api/states/${entity_id}`)).state;
const setTemp = (value: number): Promise<unknown> =>
  api(token(), '/api/services/input_number/set_value', { entity_id: TEMP, value });
const setWindow = (on: boolean): Promise<unknown> =>
  api(token(), `/api/services/input_boolean/turn_${on ? 'on' : 'off'}`, { entity_id: WINDOW });

/** The kitchen reading the heatmap shows once it has settled. */
const kitchen = (panel: Locator): Promise<number | undefined> =>
  panel.evaluate(async (el) => {
    const h = (el as WithView).view.heat!;
    await h.idle();
    return h.data?.readings.find((r) => r.entity_id === 'sensor.kitchen_temperature')?.value;
  });

/** Wait until the recorder has written `value` for `entity_id` (it commits every few seconds). */
async function recorded(entity_id: string, since: number, value: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const at = new Date(since).toISOString();
        const r = await api<{ state: string }[][]>(
          token(),
          `/api/history/period/${at}?filter_entity_id=${entity_id}&minimal_response`,
        );
        return (r[0] ?? []).map((s) => s.state);
      },
      { timeout: 30_000 },
    )
    .toContain(value);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

test('the history slider shows readings and devices as they were, then returns to live', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await savePlan(token(), PLAN, {
    ...FIXTURE,
    name: 'E2E history',
    floor_id: null,
    devices: [
      ...FIXTURE.devices,
      { id: 'win', entity_id: 'binary_sensor.kitchen_window', position: [6.4, 1.2] },
    ],
  });
  const wasTemp = Number(await state(TEMP));
  const wasWindow = (await state(WINDOW)) === 'on';
  try {
    const t0 = Date.now();
    await setTemp(31);
    await setWindow(true);
    await expect.poll(() => state('sensor.kitchen_temperature')).toBe('31.0');
    const then = Date.now();
    await page.waitForTimeout(2500);
    await setTemp(12);
    await setWindow(false);
    await expect.poll(() => state('sensor.kitchen_temperature')).toBe('12.0');
    await recorded('sensor.kitchen_temperature', t0, '12.0');
    await recorded('binary_sensor.kitchen_window', t0, 'off');

    await page.goto('/chartroom');
    const panel = page.locator('chartroom-panel');
    await panel.locator(`[role=tab][data-plan="${PLAN}"]`).click();
    await expect(panel).toHaveAttribute('data-plan', PLAN);
    await panel.getByRole('button', { name: 'Temperature', exact: true }).click();
    const marker = panel.locator('svg.plan g.device[data-entity="binary_sensor.kitchen_window"]');
    await expect(marker).toHaveClass(/\boff\b/);

    const open = panel.getByRole('button', { name: 'History' });
    await open.click();
    await expect(open).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toHaveAttribute('history', '');
    const bar = panel.locator('.timebar');
    await expect(bar).toHaveAttribute('data-entities', /^[1-9]/);
    await expect(bar.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');
    const slider = bar.getByRole('slider', { name: 'Time' });
    await expect(slider).toBeEnabled();

    // Back to when the kitchen read 31 and the window was open.
    const sec = (t: number): string => String(Math.round(t / 1000) * 1000);
    await slider.fill(sec(then + 1000));
    // The box HA nudges its simulated readings every 30 s, so 31 may have drifted a little.
    await expect.poll(() => kitchen(panel)).toBeGreaterThan(29);
    await expect(marker).toHaveClass(/\bactive\b/);
    await expect(bar.locator('.when')).not.toBeEmpty();
    await shot(page, 'panel-history.png');

    // Play moves the time on; pause stops it.
    await slider.fill((await slider.getAttribute('min'))!);
    const at = Number(await bar.getAttribute('data-at'));
    await bar.getByRole('button', { name: 'Play' }).click();
    await expect.poll(async () => Number(await bar.getAttribute('data-at'))).toBeGreaterThan(at);
    await bar.getByRole('button', { name: 'Pause' }).click();
    const paused = await bar.getAttribute('data-at');
    await page.waitForTimeout(600);
    expect(await bar.getAttribute('data-at')).toBe(paused);

    // A longer range still loads (statistics for sensors that have them, history for the rest).
    await bar.getByRole('button', { name: '7d' }).click();
    await expect(bar.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    await expect(bar).toHaveAttribute('data-entities', /^[1-9]/);

    // Live: the bar goes and the plan shows the current states again.
    await bar.getByRole('button', { name: 'Live' }).click();
    await expect(bar).toHaveCount(0);
    await expect(panel).not.toHaveAttribute('history', '');
    await expect(open).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await kitchen(panel)) ?? 99).toBeLessThan(29);
    await expect(marker).toHaveClass(/\boff\b/);
  } finally {
    await page.evaluate(() => localStorage.removeItem('chartroom:layer')).catch(() => {});
    await setTemp(wasTemp);
    await setWindow(wasWindow);
    await deletePlan(token(), PLAN);
  }
});

test('the card opens details instead of toggling a device while it shows the past', async ({
  page,
}) => {
  const plan = 'e2e-history-card';
  const light = 'light.living_room_ceiling_light';
  await savePlan(token(), plan, {
    ...FIXTURE,
    name: 'E2E history card',
    floor_id: null,
    devices: [{ id: 'light', entity_id: light, position: [6.4, 1.2] }],
  });
  const was = await state(light);
  try {
    await expect(async () => {
      await page.goto(`/${DASHBOARD}/main`);
      // The card is given hass once, so wait for one with states and the entity registry: on a
      // cold start the page has none at first, or one with neither.
      await page.waitForFunction(
        () => {
          const hass = (
            document.querySelector('home-assistant') as {
              hass?: { states?: object; entities?: object };
            } | null
          )?.hass;
          return (
            customElements.get('chartroom-card') !== undefined &&
            !!hass?.entities &&
            Object.keys(hass.states ?? {}).length > 0
          );
        },
        null,
        { timeout: 10_000 },
      );
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
    await page.evaluate((plan_id) => {
      const card = document.createElement('chartroom-card') as HTMLElement & {
        setConfig(c: unknown): void;
        hass: unknown;
      };
      card.setConfig({ type: 'custom:chartroom-card', plan_id, history: true });
      card.hass = (document.querySelector('home-assistant') as unknown as { hass: unknown }).hass;
      card.setAttribute(
        'style',
        'position:fixed;inset:0 auto auto 0;width:480px;height:420px;z-index:9',
      );
      card.addEventListener('hass-more-info', (e) => {
        card.dataset['info'] = (e as CustomEvent<{ entityId: string }>).detail.entityId;
      });
      document.body.append(card);
    }, plan);
    const card = page.locator('body > chartroom-card');
    const marker = card.locator(`g.device[data-entity="${light}"]`);
    await expect(marker).toBeVisible();
    await card.getByRole('button', { name: 'History' }).click();
    await expect(card).toHaveAttribute('history', '');
    await expect(card.getByRole('slider', { name: 'Time' })).toBeEnabled();
    await marker.click();
    await expect(card).toHaveAttribute('data-info', light);
    await page.waitForTimeout(1000);
    expect(await state(light)).toBe(was);
  } finally {
    if ((await state(light)) !== was)
      await api(token(), `/api/services/light/turn_${was === 'on' ? 'on' : 'off'}`, {
        entity_id: light,
      });
    await deletePlan(token(), plan);
  }
});
