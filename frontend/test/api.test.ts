import { describe, expect, it, vi } from 'vite-plus/test';
import { wsApi } from '../src/api';
import type { HassConnection } from '../src/ha-types';
import { emptyPlan } from '../src/plan/functions';

type Message = { type: string; [key: string]: unknown };

/** A connection that records what is sent and answers by message type. */
function connection(replies: Record<string, unknown> = {}): {
  c: HassConnection;
  sent: Message[];
} {
  const sent: Message[] = [];
  const c: HassConnection = {
    sendMessagePromise: async <T>(m: Message): Promise<T> => {
      sent.push(m);
      return replies[m.type] as T;
    },
  };
  return { c, sent };
}

describe('websocket api', () => {
  it('lists the saved plans', async () => {
    const plans = [{ id: 'home', name: 'Home', floor_id: null }];
    const { c, sent } = connection({ 'chartroom/plans/list': { plans } });
    expect(await wsApi(c).listPlans()).toEqual(plans);
    expect(sent).toEqual([{ type: 'chartroom/plans/list' }]);
  });

  it('gets a plan normalised, keeping its storage id', async () => {
    const { c, sent } = connection({ 'chartroom/plans/get': { id: 'home', name: 'Home' } });
    const { plan } = await wsApi(c).getPlan('home');
    expect(sent).toEqual([{ type: 'chartroom/plans/get', plan_id: 'home' }]);
    expect(plan).toMatchObject({ id: 'home', name: 'Home', floor_id: null, walls: [], rooms: [] });
  });

  it("drops an underlay that is not the plan's own image, keeping the rest", async () => {
    const underlay = (url: string) => ({
      url,
      width_px: 100,
      height_px: 50,
      scale: 0.05,
      origin: [0, 0],
      opacity: 0.5,
    });
    const own = underlay('/api/chartroom/underlay/home?v=0123456789ab');
    const get = (u: unknown) =>
      wsApi(connection({ 'chartroom/plans/get': { name: 'Home', underlay: u } }).c).getPlan('home');
    expect(await get(own)).toMatchObject({ plan: { underlay: own }, underlayIgnored: false });
    expect(await get(null)).toMatchObject({ plan: { underlay: null }, underlayIgnored: false });
    for (const u of [
      underlay('https://example.com/x.png'),
      underlay('/api/states'),
      underlay('/api/chartroom/underlay/other'),
      { width_px: 100 },
      'https://example.com/x.png',
      false,
      0,
      '',
    ]) {
      const { plan, underlayIgnored } = await get(u);
      expect(plan.underlay, JSON.stringify(u)).toBeNull();
      expect(underlayIgnored, JSON.stringify(u)).toBe(true);
      expect(plan.name).toBe('Home');
    }
  });

  it('rejects a plan of an unknown schema version', async () => {
    const { c } = connection({ 'chartroom/plans/get': { name: 'Next', schema_version: 2 } });
    await expect(wsApi(c).getPlan('next')).rejects.toThrow('schema_version');
  });

  it('saves a plan without its storage id', async () => {
    const { c, sent } = connection();
    const plan = emptyPlan('Home', 'ground');
    await wsApi(c).savePlan('home', { ...plan, id: 'home' } as typeof plan);
    expect(sent).toEqual([{ type: 'chartroom/plans/save', plan_id: 'home', plan }]);
  });

  it('subscribes to plan changes and hands back the unsubscribe', async () => {
    const unsubscribe = vi.fn();
    const subscribeMessage = vi.fn(async () => unsubscribe);
    const { c } = connection();
    c.subscribeMessage = subscribeMessage as HassConnection['subscribeMessage'];
    const cb = vi.fn();
    expect(await wsApi(c).subscribePlans(cb)).toBe(unsubscribe);
    expect(subscribeMessage).toHaveBeenCalledWith(cb, { type: 'chartroom/plans/subscribe' });
  });

  it('rejects a subscription the connection cannot make', async () => {
    await expect(wsApi(connection().c).subscribePlans(() => {})).rejects.toThrow();
  });

  it('reads the mesh topology and the integration info', async () => {
    const topology = { nodes: [], links: [], sources: { zha: 'ok' } };
    const { c, sent } = connection({
      'chartroom/mesh/get': topology,
      'chartroom/info': { version: '0.2.0' },
    });
    expect(await wsApi(c).mesh()).toBe(topology);
    expect(await wsApi(c).info()).toEqual({ version: '0.2.0' });
    expect(sent.map((m) => m.type)).toEqual(['chartroom/mesh/get', 'chartroom/info']);
  });
});

describe('websocket api, damaged plans', () => {
  it('opens a damaged stored plan without what nothing could draw, and says what was wrong', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { c } = connection({ 'chartroom/plans/get': { name: 'Home', walls: {}, rooms: [7] } });
    const { plan } = await wsApi(c).getPlan('home');
    expect(plan).toMatchObject({ walls: [], rooms: [] });
    expect(warn).toHaveBeenCalledWith('Chartroom: plan home:', [
      'walls is not a list',
      'rooms[0] is not an object',
    ]);
    warn.mockRestore();
  });
});
