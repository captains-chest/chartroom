import { describe, expect, it, vi } from 'vite-plus/test';
import type { ChartroomCard } from '../src/chartroom-card';
import type { Hass, HassConnection } from '../src/ha-types';
import { emptyPlan } from '../src/plan/functions';
import { FakeApi } from './fake-api';
import type { FakeElement } from './fake-dom';
import { fakeWsApi, settle } from './panel-harness';

vi.mock('../src/api', async (real) => ({
  ...(await real<typeof import('../src/api')>()),
  wsApi: (c: Parameters<typeof fakeWsApi>[0]) => fakeWsApi(c),
}));

/** A card on the page over a FakeApi with `plans`, configured with `config`. */
async function mount(config: Record<string, unknown>, plans: Record<string, string | null>) {
  const api = new FakeApi();
  for (const [id, floor] of Object.entries(plans))
    api.plans.set(id, emptyPlan(`Plan ${id}`, floor));
  const connection: HassConnection = {
    sendMessagePromise: () => Promise.reject(new Error('no websocket')),
  };
  // The harness's wsApi stand-in answers for connections it knows.
  (await import('./panel-harness')).registerApi(connection, api);
  const { ChartroomCard: Card } = await import('../src/chartroom-card');
  const card = new Card() as ChartroomCard;
  (document.createElement('body') as unknown as FakeElement).append(card as unknown as FakeElement);
  card.connectedCallback();
  card.setConfig({ type: 'custom:chartroom-card', ...config });
  card.hass = { connection, states: {} } as Hass;
  await settle();
  const find = (el: FakeElement, cls: string): FakeElement | undefined => {
    if ((el as unknown as { className?: string }).className === cls) return el;
    for (const c of [...el.children, ...(el.shadowRoot ? [el.shadowRoot] : [])])
      if (typeof c !== 'string') {
        const hit = find(c, cls);
        if (hit) return hit;
      }
    return undefined;
  };
  const message = (): string | null => {
    const m = find(card as unknown as FakeElement, 'message')!;
    return m.hidden ? null : m.textContent;
  };
  return { api, card, message };
}

describe('dashboard card', () => {
  it('shows the first plan, and follows a save made elsewhere', async () => {
    const { api, card, message } = await mount({}, { a: null, b: null });
    expect(card.dataset['plan']).toBe('a');
    expect(card.view.plan?.name).toBe('Plan a');
    expect(message()).toBeNull();
    await api.savePlan('a', emptyPlan('Renamed'));
    await settle();
    expect(card.view.plan?.name).toBe('Renamed');
  });

  it("shows a floor's plan, and says when there is none", async () => {
    const { card, message } = await mount({ floor_id: 'up' }, { a: null, b: 'up' });
    expect(card.dataset['plan']).toBe('b');
    card.setConfig({ type: 'custom:chartroom-card', floor_id: 'down' });
    await settle();
    expect(card.dataset['plan']).toBeUndefined();
    expect(message()).toBe('No plan for floor "down".');
  });

  it('stops following off the page', async () => {
    const { api, card } = await mount({ plan_id: 'a' }, { a: null });
    card.disconnectedCallback();
    await settle();
    await api.savePlan('a', emptyPlan('Renamed'));
    await settle();
    expect(card.view.plan?.name).toBe('Plan a');
  });
});
