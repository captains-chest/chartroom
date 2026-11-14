import { expect, test, type Page } from '@playwright/test';
import { deletePlan, getPlan, planCommand } from './ha';

// A home without floors, as the panel sees it. The shared test instance always has floors (and
// the example plan), and other specs run beside this one, so rather than deleting floors and
// plans in Home Assistant this spec hides them from the page: the floor registry answers with no
// floors and the plan list with only the home plan. Saving still goes to the real integration.
const HOME_PLAN_ID = 'home';
const token = (): string => process.env['HA_TOKEN'] ?? '';

type Msg = { id?: number; type?: string; success?: boolean; result?: unknown };

/** Rewrite one server message for a request of the given type. */
function hide(msg: Msg, requestType: string | undefined): Msg {
  if (msg.type !== 'result' || !msg.success || !requestType) return msg;
  if (requestType.startsWith('config/floor_registry/') && Array.isArray(msg.result))
    return { ...msg, result: [] };
  if (requestType === 'chartroom/plans/list') {
    const result = msg.result as { plans: { id: string }[] };
    return {
      ...msg,
      result: { ...result, plans: result.plans.filter((p) => p.id === HOME_PLAN_ID) },
    };
  }
  return msg;
}

/** Make Home Assistant look floorless (and plan-less, but for the home plan) to this page. */
async function hideFloorsAndPlans(page: Page): Promise<void> {
  await page.routeWebSocket(/\/api\/websocket/, (ws) => {
    const server = ws.connectToServer();
    const types = new Map<number, string>();
    const track = (m: Msg): void => {
      if (typeof m.id === 'number' && typeof m.type === 'string') types.set(m.id, m.type);
    };
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        const parsed = JSON.parse(m) as Msg | Msg[];
        for (const one of Array.isArray(parsed) ? parsed : [parsed]) track(one);
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      // With coalesce_messages, Home Assistant may send several messages as one array.
      const parsed = JSON.parse(m) as Msg | Msg[];
      const out = Array.isArray(parsed)
        ? parsed.map((one) => hide(one, types.get(one.id ?? -1)))
        : hide(parsed, types.get(parsed.id ?? -1));
      ws.send(JSON.stringify(out));
    });
  });
}

test('a home without floors gets a Home tab and a whole-home plan', async ({ page }) => {
  const { plans } = await planCommand<{ plans: { id: string }[] }>(token(), {
    type: 'chartroom/plans/list',
  });
  test.skip(
    plans.some((p) => p.id === HOME_PLAN_ID),
    'this instance already has a home plan; leave it alone',
  );
  try {
    await hideFloorsAndPlans(page);
    await page.goto('/chartroom');
    const panel = page.locator('chartroom-panel');
    const tabs = panel.locator('nav.tabs [role=tab]');

    // Just the Home tab, selected, offering to create the plan.
    await expect(tabs).toHaveCount(1);
    const home = tabs.first();
    await expect(home).toHaveText('Home');
    await expect(home).toHaveAttribute('data-tab', `plan:${HOME_PLAN_ID}`);
    await expect(home).toHaveAttribute('data-plan', '');
    await expect(home).toHaveAttribute('aria-selected', 'true');
    const empty = panel.locator('.empty');
    await expect(empty).toContainText('No floors in Home Assistant yet, and no saved plans.');
    await expect(empty.getByRole('link', { name: 'Add floors' })).toBeVisible();

    await empty.getByRole('button', { name: 'Create plan' }).click();

    // The editor opens on the new plan, still on the Home tab.
    await expect(panel.locator('.toolbar')).toBeVisible();
    await expect(panel.locator('[data-tool=wall]')).toBeVisible();
    await expect(panel).toHaveAttribute('data-plan', HOME_PLAN_ID);
    await expect(tabs).toHaveCount(1);
    await expect(home).toHaveAttribute('data-plan', HOME_PLAN_ID);
    await expect(home).toHaveAttribute('aria-selected', 'true');

    const stored = await getPlan<{ name: string; floor_id: string | null; walls: unknown[] }>(
      token(),
      HOME_PLAN_ID,
    );
    expect(stored).toMatchObject({ name: 'Home', floor_id: null, walls: [] });
  } finally {
    await deletePlan(token(), HOME_PLAN_ID);
  }
});
