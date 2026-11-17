import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DASHBOARD, DEVICES_PLAN, api, deletePlan, getPlan, savePlan } from './ha';

// Device markers on a throwaway copy of the example plan. Every entity a test switches is put
// back the way it was, and the plan is deleted afterwards.
const SHOTS = process.env['SHOTS_DIR'];
const FIXTURE = JSON.parse(readFileSync('frontend/test/fixtures/example-plan.json', 'utf8')) as {
  rooms: { id: string; polygon: Pt[] }[];
};
const token = (): string => process.env['HA_TOKEN'] ?? '';

type Pt = [number, number];
interface State {
  entity_id: string;
  state: string;
}

const state = async (entity_id: string): Promise<string | null> => {
  try {
    return (await api<State>(token(), `/api/states/${entity_id}`)).state;
  } catch {
    return null;
  }
};

/** Put an on/off or lock entity back in the state it had. */
async function restore(entity_id: string, was: string | null): Promise<void> {
  if (was === null || (await state(entity_id)) === was) return;
  const [domain] = entity_id.split('.');
  const service =
    domain === 'lock'
      ? was === 'locked'
        ? 'lock'
        : 'unlock'
      : domain === 'cover'
        ? was === 'open'
          ? 'open_cover'
          : 'close_cover'
        : was === 'on'
          ? 'turn_on'
          : 'turn_off';
  await api(token(), `/api/services/${domain}/${service}`, { entity_id });
}

const centroid = (poly: Pt[]): Pt => [
  poly.reduce((s, p) => s + p[0], 0) / poly.length,
  poly.reduce((s, p) => s + p[1], 0) / poly.length,
];
const room = (id: string): Pt[] => FIXTURE.rooms.find((r) => r.id === id)!.polygon;

/** Marker statuses for each entity state (see frontend/src/devices.ts). */
const statusOf = (entity_id: string, s: string): string =>
  entity_id.startsWith('binary_sensor.') && /door|window/.test(entity_id)
    ? s === 'on'
      ? 'open'
      : s === 'off'
        ? 'closed'
        : s
    : s;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

async function openPlan(page: Page): Promise<Locator> {
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  await panel.locator(`[role=tab][data-plan="${DEVICES_PLAN}"]`).click();
  await expect(panel).toHaveAttribute('data-plan', DEVICES_PLAN);
  return panel;
}

async function toScreen(panel: Locator, p: Pt): Promise<Pt> {
  return panel.locator('svg.plan').evaluate((svg: SVGSVGElement, q: Pt) => {
    const m = svg.getScreenCTM()!;
    return [m.a * q[0] + m.c * q[1] + m.e, m.b * q[0] + m.d * q[1] + m.f] as Pt;
  }, p);
}

const marker = (scope: Locator, entity_id: string): Locator =>
  scope.locator(`g.device[data-entity="${entity_id}"]`);

const near = (id: string, dx: number, dy: number): Pt => {
  const c = centroid(room(id));
  return [c[0] + dx, c[1] + dy];
};
const PLACED: [string, Pt][] = [
  ['light.kitchen_ceiling_light', near('kitchen_living', -0.8, 1.2)],
  ['switch.coffee_maker', near('kitchen_living', 0, 1.2)],
  ['light.kitchen_pendant_unreachable', near('kitchen_living', 0.8, 1.2)],
  ['binary_sensor.front_door', near('hall', -0.3, 0.1)],
  ['lock.front_door_lock', near('hall', 0.4, 0.1)],
];

async function savePlaced(extra: [string, Pt][] = []): Promise<string[]> {
  const placed = [...PLACED, ...extra];
  const present: string[] = [];
  for (const [id] of placed) if ((await state(id)) !== null) present.push(id);
  await savePlan(token(), DEVICES_PLAN, {
    ...FIXTURE,
    name: 'E2E devices',
    floor_id: null,
    devices: placed
      .filter(([id]) => present.includes(id))
      .map(([entity_id, position], i) => ({
        id: `device_${i + 1}`,
        entity_id,
        position,
      })),
  });
  return present;
}

test.describe('devices', () => {
  test.describe.configure({ mode: 'serial' });
  test.afterEach(async () => {
    await deletePlan(token(), DEVICES_PLAN);
  });

  test('devices are auto-placed by area, dragged from the list and saved', async ({ page }) => {
    // Link the open-plan room to Living room only, so the Kitchen area has no room.
    const rooms = FIXTURE.rooms.map((r) =>
      r.id === 'kitchen_living' ? { ...r, area_ids: ['living_room'] } : r,
    );
    await savePlan(token(), DEVICES_PLAN, {
      ...FIXTURE,
      rooms,
      name: 'E2E devices',
      floor_id: null,
    });
    const panel = await openPlan(page);
    await panel.locator('button.edit').click();
    await panel.locator('[data-tool=device]').click();
    const list = panel.locator('[data-panel=devices]');
    await expect(list).toBeVisible();

    await list.locator('[data-action=auto-place]').click();
    await expect(list.locator('[role=status]')).toContainText(/Placed \d+ device/);
    // The front door is in the Hall area, so it lands inside the Hall room.
    const door = marker(panel, 'binary_sensor.front_door');
    await expect(door).toHaveCount(1);
    const doorPos = await door.evaluate((g) => g.getAttribute('transform'));
    expect(doorPos).toMatch(/^translate\(/);

    // The Kitchen area has no room on this plan, so its light is placed by hand.
    const item = list.locator('li[data-entity="light.kitchen_ceiling_light"]');
    await list.locator('input[name=device-filter]').fill('kitchen ceiling');
    await expect(item).toBeVisible();
    const target: Pt = centroid(room('kitchen_living'));
    const [x, y] = await toScreen(panel, target);
    const svgBox = (await panel.locator('svg.plan').boundingBox())!;
    await item.dragTo(panel.locator('svg.plan'), {
      targetPosition: { x: x - svgBox.x, y: y - svgBox.y },
    });
    const light = marker(panel, 'light.kitchen_ceiling_light');
    await expect(light).toHaveCount(1);
    await expect(panel.locator('[data-panel=device] select[name=entity]')).toHaveValue(
      'light.kitchen_ceiling_light',
    );
    await expect(panel.locator('.save-state')).toHaveText('Saved', { timeout: 10_000 });
    await shot(page, 'editor-devices.png');

    const stored = await getPlan<{
      devices: { entity_id: string; position: Pt }[];
    }>(token(), DEVICES_PLAN);
    const placed = stored.devices.find((d) => d.entity_id === 'light.kitchen_ceiling_light')!;
    expect(Math.hypot(placed.position[0] - target[0], placed.position[1] - target[1])).toBeLessThan(
      0.3,
    );
    expect(stored.devices.some((d) => d.entity_id === 'binary_sensor.front_door')).toBe(true);
    expect(new Set(stored.devices.map((d) => d.entity_id)).size).toBe(stored.devices.length);
  });

  test('markers show live state, toggle on tap and open details on hold', async ({ page }) => {
    const present = await savePlaced();
    const coffee = 'switch.coffee_maker';
    const was = await state(coffee);
    test.skip(was === null, 'no switch.coffee_maker on this instance');
    try {
      const panel = await openPlan(page);
      for (const id of present) {
        const s = (await state(id))!;
        await expect(marker(panel, id)).toHaveAttribute('data-status', statusOf(id, s));
      }
      if (present.includes('light.kitchen_pendant_unreachable'))
        await expect(marker(panel, 'light.kitchen_pendant_unreachable')).toHaveAttribute(
          'data-status',
          'unavailable',
        );
      await shot(page, 'panel-devices.png');

      // Tap toggles; the marker follows the new state pushed by Home Assistant.
      const m = marker(panel, coffee);
      await m.click();
      const flipped = was === 'on' ? 'off' : 'on';
      await expect.poll(() => state(coffee)).toBe(flipped);
      await expect(m).toHaveAttribute('data-status', flipped);
      // The keyboard does the same.
      await m.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => state(coffee)).toBe(was);
      await expect(m).toHaveAttribute('data-status', was!);

      // A state change made elsewhere shows up without a reload.
      await restore(coffee, flipped);
      await expect(m).toHaveAttribute('data-status', flipped);
      await restore(coffee, was);
      await expect(m).toHaveAttribute('data-status', was!);

      // Hold opens Home Assistant's more-info dialog; so does a sensor tap.
      const box = (await m.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(800);
      await page.mouse.up();
      const info = page.locator('ha-more-info-dialog');
      await expect(info).toBeAttached();
      await expect(info.getByText('Coffee maker').first()).toBeVisible();
      expect(await state(coffee)).toBe(was);
      await page.keyboard.press('Escape');
    } finally {
      await restore(coffee, was);
    }
  });

  test('right-click on a marker opens details without toggling', async ({ page }) => {
    const present = await savePlaced();
    const coffee = 'switch.coffee_maker';
    test.skip(!present.includes(coffee), 'no switch.coffee_maker on this instance');
    const was = await state(coffee);
    const panel = await openPlan(page);
    const box = (await marker(panel, coffee).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    const info = page.locator('ha-more-info-dialog');
    await expect(info).toBeAttached();
    await expect(info.getByText('Coffee maker').first()).toBeVisible();
    expect(await state(coffee)).toBe(was);
  });

  test('hovering or focusing a marker says which device it is', async ({ page }) => {
    const temp = 'sensor.kitchen_temperature';
    const present = await savePlaced([[temp, near('kitchen_living', 0, 2)]]);
    const coffee = 'switch.coffee_maker';
    test.skip(!present.includes(coffee), 'no switch.coffee_maker on this instance');
    const panel = await openPlan(page);
    const pop = panel.locator('.device-popover');
    const hover = async (id: string): Promise<void> => {
      const b = (await marker(panel, id).boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    };

    // The mouse: after a short rest, the name and each entity's state; gone once it leaves.
    await hover(coffee);
    await expect(pop).toBeVisible();
    await expect(pop.locator('.dp-title')).toHaveText('Coffee maker');
    await expect(pop.locator('.dp-value')).toHaveText((await state(coffee))!);
    await expect(marker(panel, coffee)).toHaveAttribute(
      'aria-describedby',
      'chartroom-device-popover',
    );
    if (present.includes(temp)) {
      await hover(temp);
      await expect(pop.locator('.dp-title')).toHaveText('Kitchen temperature');
      await expect(pop.locator('.dp-area')).toHaveText('Kitchen');
      await expect(pop.locator('.dp-value')).toHaveText(/^-?\d+(\.\d+)? °C$/);
    }
    if (present.includes('light.kitchen_pendant_unreachable')) {
      await hover('light.kitchen_pendant_unreachable');
      await expect(pop.locator('li.unavailable .dp-value')).toHaveText('unavailable');
    }
    await shot(page, 'device-popover.png');
    await page.mouse.move(5, 5);
    await expect(pop).toBeHidden();

    // The keyboard: focus shows it (not a click's: a key press first, as when tabbing), Esc hides it.
    const door = marker(panel, 'binary_sensor.front_door');
    await page.keyboard.press('Shift');
    await door.focus();
    await expect(pop.locator('.dp-title')).toHaveText('Front door');
    await expect(pop.locator('.dp-value')).toHaveText(/^(open|closed)$/);
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
  });

  test('a lock asks before it unlocks', async ({ page }) => {
    const lock = 'lock.front_door_lock';
    const was = await state(lock);
    test.skip(was === null, 'no lock on this instance (the CI config has one)');
    await savePlaced();
    try {
      await restore(lock, 'locked');
      const panel = await openPlan(page);
      const m = marker(panel, lock);
      await expect(m).toHaveAttribute('data-status', 'locked');
      const dialog = panel.locator('dialog.confirm');
      await m.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Unlock Front door lock?');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(await state(lock)).toBe('locked');
      await m.click();
      await dialog.getByRole('button', { name: 'Unlock' }).click();
      await expect.poll(() => state(lock)).toBe('unlocked');
      await expect(m).toHaveAttribute('data-status', 'unlocked');
    } finally {
      await restore(lock, was);
    }
  });

  test('the card shows the configured plan with live markers', async ({ page }) => {
    const present = await savePlaced();
    const card = page.locator('chartroom-card[data-plan="e2e-devices"]');
    await expect(async () => {
      await page.goto(`/${DASHBOARD}/main`);
      await expect(card.locator('svg.plan')).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
    await expect(card.locator('h2.title')).toHaveText('Devices');
    for (const id of present) {
      const s = (await state(id))!;
      await expect(marker(card, id)).toHaveAttribute('data-status', statusOf(id, s));
    }
    // The card does not zoom: the page keeps scrolling over it.
    const vb = await card.locator('svg.plan').getAttribute('viewBox');
    const r = (await card.locator('svg.plan').boundingBox())!;
    await page.mouse.move(r.x + 10, r.y + 10);
    await page.mouse.wheel(0, 200);
    await expect(card.locator('svg.plan')).toHaveAttribute('viewBox', vb!);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'card.png');
  });
});
