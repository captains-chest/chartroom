import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, deletePlan, savePlan, withSocket } from './ha';
import { useHeatDebug } from './heat-debug';

// Signal strength and mesh links on a throwaway copy of the example plan with an access point,
// a radio, a few devices and the bedroom door wired to the kitchen window sensor (both test configs have it). The plan is deleted
// afterwards, the door sensor put back, and the fake mesh topology cleared.
const SHOTS = process.env['SHOTS_DIR'];
const PLAN = 'e2e-signal';
const token = (): string => process.env['HA_TOKEN'] ?? '';
const FIXTURE = JSON.parse(readFileSync('frontend/test/fixtures/example-plan.json', 'utf8')) as {
  doors: { id: string; entity_id?: string }[];
};
const DOOR_SWITCH = 'input_boolean.kitchen_window';
const DEVICES: [string, [number, number]][] = [
  ['light.kitchen_ceiling_light', [5.6, 2.2]],
  ['switch.coffee_maker', [6.6, 3.4]],
  ['binary_sensor.front_door', [1.5, 7.3]],
  ['lock.front_door_lock', [9.7, 7.5]],
];

interface Heat {
  renderer: string;
  mode: string;
  idle(): Promise<void>;
}
type WithView = HTMLElement & {
  view: { heat: Heat | null; mesh: { links: { quality: number | null }[] } | null };
};

function plan(): unknown {
  return {
    ...FIXTURE,
    name: 'E2E signal',
    floor_id: null,
    doors: FIXTURE.doors.map((d) =>
      d.id === 'door_bedroom_1' ? { ...d, entity_id: 'binary_sensor.kitchen_window' } : d,
    ),
    sources: [
      { id: 'ap_living', kind: 'access_point', entity_id: '', position: [5.2, 2.0], tx_dbm: -35 },
      { id: 'radio_bed', kind: 'radio', entity_id: '', position: [9.2, 6.6] },
    ],
    devices: DEVICES.map(([entity_id, position], i) => ({ id: `d${i}`, entity_id, position })),
  };
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.locator('#ha-launch-screen').waitFor({ state: 'detached', timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/${name}` });
}

async function openPlan(page: Page): Promise<Locator> {
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  await panel.locator(`[role=tab][data-plan="${PLAN}"]`).click();
  await expect(panel).toHaveAttribute('data-plan', PLAN);
  await expect(panel.locator('svg.plan [data-kind=room]')).toHaveCount(5);
  return panel;
}

const field = (panel: Locator): Promise<{ renderer: string; field: number[] }> =>
  panel.evaluate((el) => window.chartroomDebug.readField((el as WithView).view.heat));
const settled = (panel: Locator): Promise<{ renderer: string; mode: string }> =>
  panel.evaluate(async (el) => {
    const h = (el as WithView).view.heat!;
    await h.idle();
    return { renderer: h.renderer, mode: h.mode };
  });

const doorState = async (): Promise<string> =>
  (await api<{ state: string }>(token(), `/api/states/${DOOR_SWITCH}`)).state;
const setDoor = (on: boolean): Promise<unknown> =>
  api(token(), `/api/services/input_boolean/turn_${on ? 'on' : 'off'}`, { entity_id: DOOR_SWITCH });

const setTopology = (topology: unknown): Promise<unknown> =>
  withSocket(token(), (send) => send({ type: 'chartroom/mesh/test_source', topology }));

test.beforeEach(({ page }) => useHeatDebug(page));

test.describe('signal and mesh', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async () => {
    await savePlan(token(), PLAN, plan());
  });
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      localStorage.removeItem('chartroom:renderer');
      localStorage.removeItem('chartroom:layer');
      localStorage.removeItem('chartroom:mesh');
      localStorage.removeItem('chartroom:signal-network');
    });
    await deletePlan(token(), PLAN);
  });

  test('the signal layer traces walls the same in WebGL2 and the worker', async ({ page }) => {
    const panel = await openPlan(page);
    const signal = panel.getByRole('button', { name: 'Signal' });
    await expect(signal).toBeEnabled();
    await signal.click();
    const legend = panel.locator('.heat-legend');
    await expect(legend.locator('.heat-title')).toContainText('Signal');
    await expect(legend).toContainText('dBm');
    await expect(legend).toContainText('2 sources');
    await expect(legend).toContainText(/\d+ wall segments/);
    // No value labels: a source's level at 1 m is not a reading.
    await expect(panel.locator('svg.plan text.heat-value')).toHaveCount(0);
    expect(await settled(panel)).toEqual({ renderer: 'webgl2', mode: 'signal' });

    const r = await panel.evaluate((el) =>
      window.chartroomDebug.compareRenderers((el as WithView).view.heat),
    );
    console.log('signal agreement', JSON.stringify(r));
    expect(r).not.toBeNull();
    expect(r!.cells).toBeGreaterThan(5000);
    // Same model in float32 (GPU) and float64 (worker): equal bar the odd cell whose ray grazes
    // a wall end, where one side counts the wall and the other does not.
    expect(r!.fieldP999Diff).toBeLessThan(0.05);
    expect(r!.fieldOver).toBeLessThan(r!.cells / 200);
    expect(r!.fadeMaxDiff).toBeLessThan(1e-3);
    expect(r!.pixelMeanDiff).toBeLessThan(2);
    await shot(page, 'signal-webgl2.png');

    // Opening the bedroom door (its sensor says on) lets more signal into the bedroom.
    const was = await doorState();
    try {
      await setDoor(false);
      await expect.poll(async () => (await settled(panel)).mode).toBe('signal');
      const closed = (await field(panel)).field;
      await setDoor(true);
      await expect
        .poll(async () => {
          const open = (await field(panel)).field;
          let up = 0;
          for (let i = 0; i < open.length; i += 3) if (open[i]! > closed[i]! + 0.5) up++;
          return up;
        })
        .toBeGreaterThan(50);
    } finally {
      if ((await doorState()) !== was) await setDoor(was === 'on');
    }

    // Forced onto the Canvas2D fallback, the worker traces the same field.
    const gl = await field(panel);
    await page.evaluate(() => localStorage.setItem('chartroom:renderer', 'canvas'));
    await page.reload();
    await expect(panel.locator('.heat-legend .heat-title')).toContainText('Signal');
    expect(await settled(panel)).toEqual({ renderer: 'canvas', mode: 'signal' });
    const cpu = await field(panel);
    expect(cpu.field.length).toBe(gl.field.length);
    const diffs: number[] = [];
    for (let i = 0; i < cpu.field.length; i += 3)
      diffs.push(Math.abs(cpu.field[i]! - gl.field[i]!));
    diffs.sort((a, b) => a - b);
    expect(diffs[Math.floor(diffs.length * 0.999)]!).toBeLessThan(0.05);
    await shot(page, 'signal-canvas-fallback.png');
  });

  test('mesh links join placed devices, coloured by link quality', async ({ page }) => {
    const ids = DEVICES.map(([e]) => e);
    try {
      await setTopology({
        nodes: [
          { id: 'z:c', name: 'Coordinator', role: 'coordinator', entities: [ids[0]] },
          { id: 'z:p', name: 'Coffee plug', role: 'router', via: 'z:c', entities: [ids[1]] },
          { id: 'z:d', name: 'Front door', role: 'end_device', via: 'z:p', entities: [ids[2]] },
          { id: 'z:l', name: 'Lock', role: 'end_device', via: 'z:c', entities: [ids[3]] },
          { id: 'z:x', name: 'Not on this plan', role: 'router', entities: ['light.nowhere'] },
        ],
        links: [
          { a: 'z:c', b: 'z:p', lqi: 240, relationship: 'route' },
          { a: 'z:p', b: 'z:d', lqi: 90, relationship: 'parent' },
          { a: 'z:c', b: 'z:l', rssi: -84, relationship: 'parent' },
          { a: 'z:d', b: 'z:l' },
          { a: 'z:p', b: 'z:x', lqi: 200, relationship: 'sibling' },
        ],
      });
      const panel = await openPlan(page);
      const mesh = panel.getByRole('button', { name: 'Mesh' });
      await mesh.click();
      await expect(mesh).toHaveAttribute('aria-pressed', 'true');
      const lines = panel.locator('svg.plan g.mesh line.mesh-link');
      await expect(lines).toHaveCount(4);
      await expect(panel.locator('svg.plan g.mesh line.mesh-link.unknown')).toHaveCount(1);
      await expect(panel.locator('.mesh-note')).toHaveText('Mesh: 4 links on this plan · Test');
      const q = await panel.evaluate((el) =>
        (el as WithView).view.mesh!.links.map((l) => l.quality),
      );
      expect(q.map((v) => (v === null ? null : Math.round(v * 100) / 100))).toEqual([
        0.94,
        0.35,
        0.12,
        null,
      ]);
      await expect(lines.first().locator('title')).toHaveText(
        'Coordinator – Coffee plug: LQI 240 · route',
      );
      // The coordinator and the plug get a ring.
      await expect(panel.locator('svg.plan g.mesh line.mesh-node')).toHaveCount(2);
      // Hovering the door names its role and route, and highlights the route's two links.
      const door = (await panel.locator(`g.device[data-entity="${ids[2]}"]`).boundingBox())!;
      await page.mouse.move(door.x + door.width / 2, door.y + door.height / 2);
      const pop = panel.locator('.device-popover .dp-mesh');
      await expect(pop).toHaveText([
        'Test end device',
        'Route: → Coffee plug (LQI 90) → Coordinator (LQI 240) · 2 hops',
      ]);
      await expect(panel.locator('svg.plan g.mesh.focus line.on-path')).toHaveCount(2);
      await shot(page, 'mesh-route.png');
      await page.mouse.move(1, 1);
      await expect(panel.locator('svg.plan g.mesh.focus')).toHaveCount(0);
      // Without hover (touch), the menu's Route shows the same and keeps it until the next press
      // or Esc; it never acts on the device (#125).
      const plugState = async (): Promise<string> =>
        (await api<{ state: string }>(token(), `/api/states/${ids[1]}`)).state;
      const before = await plugState();
      const plug = (await panel.locator(`g.device[data-entity="${ids[1]}"]`).boundingBox())!;
      const route = async (): Promise<void> => {
        await page.mouse.click(plug.x + plug.width / 2, plug.y + plug.height / 2, {
          button: 'right',
        });
        await panel.locator('.device-menu').getByRole('menuitem', { name: 'Route' }).click();
        await page.mouse.move(1, 1);
        await expect(pop).toHaveText(['Test router', 'Route: → Coordinator (LQI 240) · 1 hop']);
        await expect(panel.locator('svg.plan g.mesh.focus line.on-path')).toHaveCount(1);
      };
      await route();
      await page.keyboard.press('Escape');
      await expect(panel.locator('svg.plan g.mesh.focus')).toHaveCount(0);
      await expect(panel.locator('.device-popover')).toBeHidden();
      // A tap on the marker only dismisses it: the plug is not toggled.
      await route();
      await page.mouse.click(plug.x + plug.width / 2, plug.y + plug.height / 2);
      await expect(panel.locator('svg.plan g.mesh.focus')).toHaveCount(0);
      await page.waitForTimeout(500);
      expect(await plugState()).toBe(before);
      // With the signal layer under it, built from the mesh's routers (one link with RSSI is too
      // few to fit a level), then remembered across a reload.
      await panel.getByRole('button', { name: 'Signal' }).click();
      const legend = panel.locator('.heat-legend');
      await expect(legend.locator('.heat-title')).toContainText('Signal');
      await expect(legend).toContainText(
        'Test · 2 routers · -45 dBm @1 m (default; 1 measured, too few to fit)',
      );
      await settled(panel);
      await shot(page, 'mesh-links.png');
      // Hovering the lock: the map's level at its spot, and its measured link next to the map's.
      const lock = (await panel.locator(`g.device[data-entity="${ids[3]}"]`).boundingBox())!;
      await page.mouse.move(lock.x + lock.width / 2, lock.y + lock.height / 2);
      await expect(pop).toHaveText([
        'Test end device',
        'Route: → Coordinator (RSSI -84 dBm) · 1 hop',
        /^Signal map here: -\d+ dBm$/,
        /^Coordinator: measured -84 dBm, map -\d+ dBm$/,
      ]);
      await page.mouse.move(1, 1);
      // The access points and radios instead.
      await panel.getByRole('combobox', { name: 'Signal from' }).selectOption({
        label: 'Access points and radios',
      });
      await expect(legend).toContainText('2 sources');
      await page.reload();
      await expect(panel.getByRole('button', { name: 'Mesh' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(lines).toHaveCount(4);
      await panel.getByRole('button', { name: 'Mesh' }).click();
      await expect(panel.locator('svg.plan g.mesh')).toBeHidden();
      await expect(panel.locator('.mesh-note')).toBeHidden();
    } finally {
      await setTopology(null);
    }
  });
});
