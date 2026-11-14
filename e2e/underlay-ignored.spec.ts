import { expect, test, type Locator, type Page } from '@playwright/test';

// A plan stored before #34 may hold an underlay URL outside Chartroom. The panel drops it on load
// and tells admins (only) why the drawing is gone (#35). The integration now refuses to save such
// a plan, so rather than writing Home Assistant's storage files this spec puts the foreign URL
// into the page's `chartroom/plans/get` reply for the example plan. The non-admin is simulated
// the same way, by answering `auth/current_user` with is_admin false: the panel reads the role
// from hass.user, which the frontend fills from that reply. Nothing on the server changes.
const PLAN_ID = 'example';
const FOREIGN = 'https://underlay.example.invalid/house.png';

type Msg = { id?: number; type?: string; success?: boolean; result?: unknown; plan_id?: unknown };

/** Rewrite one server message, given the request it answers. */
function rewrite(msg: Msg, request: Msg | undefined, admin: boolean): Msg {
  if (msg.type !== 'result' || !msg.success || !request) return msg;
  if (request.type === 'chartroom/plans/get' && request.plan_id === PLAN_ID)
    return {
      ...msg,
      result: {
        ...(msg.result as object),
        underlay: { url: FOREIGN, scale: 0.01, width_px: 1200, origin: { x: 0, y: 0 } },
      },
    };
  if (request.type === 'auth/current_user' && !admin)
    return { ...msg, result: { ...(msg.result as object), is_admin: false } };
  return msg;
}

/** The example plan comes with a foreign underlay, for an admin or (admin false) a plain user. */
async function foreignUnderlay(page: Page, admin: boolean): Promise<void> {
  await page.routeWebSocket(/\/api\/websocket/, (ws) => {
    const server = ws.connectToServer();
    const requests = new Map<number, Msg>();
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        const parsed = JSON.parse(m) as Msg | Msg[];
        for (const one of Array.isArray(parsed) ? parsed : [parsed])
          if (typeof one.id === 'number') requests.set(one.id, one);
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      // With coalesce_messages, Home Assistant may send several messages as one array.
      const parsed = JSON.parse(m) as Msg | Msg[];
      const out = Array.isArray(parsed)
        ? parsed.map((one) => rewrite(one, requests.get(one.id ?? -1), admin))
        : rewrite(parsed, requests.get(parsed.id ?? -1), admin);
      ws.send(JSON.stringify(out));
    });
  });
}

/** Open the panel on the example plan and wait until it is drawn. */
async function openExample(page: Page): Promise<{ panel: Locator; fetched: string[] }> {
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('https://underlay.example.invalid/')) fetched.push(r.url());
  });
  await page.goto('/chartroom');
  const panel = page.locator('chartroom-panel');
  const tab = panel.locator(`[role=tab][data-plan=${PLAN_ID}]`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('data-plan', PLAN_ID);
  await expect(panel.locator('svg.plan [data-kind=wall]').first()).toBeVisible();
  // The plan shows without the underlay.
  await expect(panel.locator('svg.underlay-svg .underlay image')).toHaveCount(0);
  await expect(panel.locator('.underlay-controls')).toBeHidden();
  return { panel, fetched };
}

test('an admin is told the stored underlay pointed outside Chartroom', async ({ page }) => {
  await foreignUnderlay(page, true);
  const { panel, fetched } = await openExample(page);
  await expect(panel.locator('button.edit')).toBeVisible();
  const note = panel.locator('.underlay-ignored');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('role', 'status');
  await expect(note).toContainText('underlay pointed outside Chartroom');
  await expect(note).toContainText('Import the image again under Edit › Underlay.');

  // The editor says it in its Underlay section instead; the note comes back on leaving it. Nothing
  // is edited, so closing the editor saves nothing over the shared example plan.
  await panel.locator('button.edit').click();
  await expect(panel.locator('.toolbar')).toBeVisible();
  await expect(note).toBeHidden();
  await expect(panel.locator('[data-panel=underlay] [data-hint=underlay-ignored]')).toContainText(
    'pointed outside Chartroom',
  );
  await panel.locator('button.edit').click();
  await expect(panel.locator('.toolbar')).toHaveCount(0);
  await expect(note).toBeVisible();
  // The foreign URL is never fetched.
  expect(fetched).toEqual([]);
});

test('a non-admin sees the plan without the note', async ({ page }) => {
  await foreignUnderlay(page, false);
  const { panel, fetched } = await openExample(page);
  // The role took: a non-admin gets no Edit button.
  await expect(panel.locator('button.edit')).toBeHidden();
  await expect(panel.locator('.underlay-ignored')).toBeHidden();
  await expect(panel.locator('.underlay-ignored')).toHaveAttribute('hidden', '');
  expect(fetched).toEqual([]);
});
