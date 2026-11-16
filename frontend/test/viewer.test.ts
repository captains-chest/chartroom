import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass, HassConnection } from '../src/ha-types';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { PlanView } from '../src/plan-view';
import { TimeBar } from '../src/time-bar';
import { type FollowResult, type FollowRule, ViewerController } from '../src/viewer';
import { FakeApi } from './fake-api';
import { installFakeDom } from './fake-dom';

// The heatmap needs a canvas and a worker: a stand-in that records what the view asks of it.
vi.mock('../src/heat-layer', () => ({
  HeatLayer: class {
    dispose = vi.fn();
    setLayer = vi.fn();
    setView = vi.fn();
    setHass = vi.fn();
    setPlan = vi.fn();
    onReadings = null;
  },
  renderValueLabels: () => {},
  declutterLabels: () => {},
}));

installFakeDom();

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};

/** The recorded state of sensor.t for the History slider. */
const RECORDED = '15';

function sensorPlan(name = 'Home'): Plan {
  const p = emptyPlan(name);
  p.sources = [{ id: 't', kind: 'sensor', entity_id: 'sensor.t', position: [1, 1] }];
  return p;
}

/**
 * A connection with the recorder's history of sensor.t (for the slider), counting history fetches
 * and keeping its 'ready' listeners (for the update notice).
 */
function recorder(): { c: HassConnection; fetches: () => number; ready: Set<() => void> } {
  let fetches = 0;
  const ready = new Set<() => void>();
  const c: HassConnection = {
    sendMessagePromise: async <T>(m: { type: string }): Promise<T> => {
      if (m.type !== 'history/history_during_period') return {} as T;
      fetches++;
      return { 'sensor.t': [{ s: RECORDED, lu: 0 }] } as T;
    },
    addEventListener: (_e, fn) => ready.add(fn),
    removeEventListener: (_e, fn) => ready.delete(fn),
  };
  return { c, fetches: () => fetches, ready };
}

function liveHass(c?: HassConnection): Hass {
  return {
    states: {
      'sensor.t': {
        entity_id: 'sensor.t',
        state: '21',
        attributes: { device_class: 'temperature', unit_of_measurement: '°C' },
      },
    },
    connection: c,
    callService: async () => {},
  };
}

type Clickable = { listeners: Map<string, Set<() => void>> };
const click = (el: unknown): void => (el as Clickable).listeners.get('click')?.forEach((f) => f());

function setup() {
  const api = new FakeApi();
  api.plans.set('home', sensorPlan());
  api.plans.set('other', sensorPlan('Other'));
  const el = document.createElement('div');
  Object.assign(el, { shadowRoot: document.createElement('div') });
  document.createElement('main').append(el);
  const bars: HTMLElement[] = [];
  const changed = vi.fn();
  const view = new PlanView(true);
  const viewer = new ViewerController(view, { el, place: (b) => bars.push(b), changed }, () => api);
  return { api, el, view, viewer, bars, changed };
}

describe('viewer controller', () => {
  it('loads a plan through the api into the view', async () => {
    const { viewer, view } = setup();
    expect(viewer.api).toBeNull();
    await expect(viewer.load('home')).rejects.toThrow('not connected');

    viewer.hass = liveHass(recorder().c);
    const loaded = await viewer.load('home');
    expect(loaded).toMatchObject({ plan: { name: 'Home' }, underlayIgnored: false });
    expect(view.plan).toBe(loaded?.plan);
  });

  it('says when it dropped an underlay that pointed outside Chartroom', async () => {
    const { api, viewer, view } = setup();
    viewer.hass = liveHass(recorder().c);
    const underlay = (url: string) => ({
      url,
      width_px: 100,
      height_px: 50,
      scale: 0.05,
      origin: [0, 0] as [number, number],
      opacity: 0.5,
    });
    api.plans.set('home', { ...sensorPlan(), underlay: underlay('https://example.com/x.png') });
    api.plans.set('other', {
      ...sensorPlan('Other'),
      underlay: underlay('/api/chartroom/underlay/other'),
    });
    expect(await viewer.load('home')).toMatchObject({
      plan: { name: 'Home', underlay: null },
      underlayIgnored: true,
    });
    expect(view.plan?.underlay).toBeNull();
    expect(await viewer.load('other')).toMatchObject({
      plan: { underlay: { url: '/api/chartroom/underlay/other' } },
      underlayIgnored: false,
    });
  });

  it('drops a load that a later one overtook', async () => {
    const { api, viewer, view } = setup();
    viewer.hass = liveHass(recorder().c);
    let open = (): void => {};
    api.gate = new Promise((resolve) => (open = resolve));
    const first = viewer.load('home');
    const current = viewer.begin();
    const second = viewer.load('other', current);
    open();
    expect(await first).toBeNull();
    expect((await second)?.plan.name).toBe('Other');
    expect(view.plan?.name).toBe('Other');
    expect(current()).toBe(true);
  });

  it('shows a heat layer only while the plan has a sensor for it', async () => {
    const { viewer, view } = setup();
    viewer.hass = liveHass(recorder().c);
    viewer.setLayer('temperature');
    expect(view.layer).toBeNull();
    await viewer.load('home');
    expect(view.layer).toBe('temperature');
    viewer.hass = { ...liveHass(), states: {} };
    expect(view.layer).toBeNull();
  });

  it('leaves the layer buttons alone when a state the plan does not read changes', async () => {
    const { viewer } = setup();
    const live = liveHass(recorder().c);
    viewer.hass = live;
    await viewer.load('home');
    const update = vi.spyOn(viewer.layers, 'update');
    viewer.hass = {
      ...live,
      states: { ...live.states, 'light.x': { entity_id: 'light.x', state: 'on', attributes: {} } },
    };
    expect(update).not.toHaveBeenCalled();
    viewer.hass = {
      ...live,
      states: { ...live.states, 'sensor.t': { ...live.states!['sensor.t']!, state: '22' } },
    };
    expect(update).toHaveBeenCalledOnce();
  });

  it('switches the mesh once, and tells the host only what the user picked', async () => {
    const { viewer, view, changed } = setup();
    const setMesh = vi.spyOn(view, 'setMesh');
    viewer.setMesh(true);
    viewer.setMesh(true);
    viewer.setLayer('humidity');
    expect(setMesh).toHaveBeenCalledOnce();
    expect(viewer.layers.mesh.getAttribute('aria-pressed')).toBe('true');
    expect(changed).not.toHaveBeenCalled();

    click(viewer.layers.mesh);
    expect(setMesh).toHaveBeenLastCalledWith(false);
    expect(changed).toHaveBeenLastCalledWith('humidity', false);
    view.dispose();
  });

  it('shows the recorded states while the History slider is open, then live again', async () => {
    const { viewer, view, el, bars } = setup();
    const { c } = recorder();
    const live = liveHass(c);
    viewer.hass = live;
    await viewer.load('home');
    const setHass = vi.spyOn(view, 'setHass');

    await viewer.toggleTime();
    expect(bars).toHaveLength(1);
    expect(el.hasAttribute('history')).toBe(true);
    expect(viewer.timeButton.getAttribute('aria-pressed')).toBe('true');
    const past = viewer.shown();
    expect(past?.states?.['sensor.t']?.state).toBe(RECORDED);
    // No service calls in the past: device controls open details instead of toggling.
    expect(past?.callService).toBeUndefined();
    expect(setHass).toHaveBeenLastCalledWith(past);

    click(viewer.timeButton);
    expect(viewer.shown()).toBe(live);
    expect(setHass).toHaveBeenLastCalledWith(live);
    expect(el.hasAttribute('history')).toBe(false);
    expect(viewer.timeButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('fetches the history again for another plan, not for the same one', async () => {
    const { viewer } = setup();
    const { c, fetches } = recorder();
    viewer.hass = liveHass(c);
    await viewer.load('home');
    await viewer.toggleTime();
    expect(fetches()).toBe(1);
    await viewer.load('home');
    expect(fetches()).toBe(1);
    await viewer.load('other');
    await vi.waitFor(() => expect(fetches()).toBe(2));
  });

  describe('following a plan', () => {
    const first: FollowRule = { pick: (plans) => plans[0] };
    const follow = (rule: FollowRule = first) => {
      const t = setup();
      const reports: FollowResult[] = [];
      t.viewer.follow(rule, (r) => reports.push(r));
      const lists = vi.spyOn(t.api, 'listPlans');
      return { ...t, reports, lists };
    };
    const names = (reports: FollowResult[]) =>
      reports.map((r) =>
        r.kind === 'plan' ? `${r.loaded.plan.name}${r.moved ? '*' : ''}` : r.kind,
      );

    it('loads once connected, then reloads when the plan is saved elsewhere', async () => {
      const { viewer, view, api, reports } = follow();
      await settle();
      expect(reports).toEqual([]);
      viewer.hass = liveHass(recorder().c);
      await vi.waitFor(() => expect(names(reports)).toEqual(['Home*']));
      expect(view.plan?.name).toBe('Home');

      await api.savePlan('home', sensorPlan('Renamed'));
      await vi.waitFor(() => expect(names(reports)).toEqual(['Home*', 'Renamed']));
      expect(view.plan?.name).toBe('Renamed');
    });

    it('does not reload for its own save', async () => {
      const { viewer, api, reports, lists } = follow();
      viewer.hass = liveHass(recorder().c);
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      await viewer.save('home', sensorPlan('Mine'));
      await settle();
      expect(api.plans.get('home')?.name).toBe('Mine');
      expect(lists).toHaveBeenCalledOnce();
      // A save from elsewhere after it still reloads.
      await api.savePlan('home', sensorPlan('Theirs'));
      await vi.waitFor(() => expect(names(reports)).toEqual(['Home*', 'Theirs']));
    });

    it('ignores other plans when the rule names one', async () => {
      const { viewer, api, reports, lists } = follow({
        planId: 'other',
        pick: (plans) => plans.find((p) => p.id === 'other'),
      });
      viewer.hass = liveHass(recorder().c);
      await vi.waitFor(() => expect(names(reports)).toEqual(['Other*']));
      await api.savePlan('home', sensorPlan('Elsewhere'));
      await settle();
      expect(lists).toHaveBeenCalledOnce();
    });

    it('says when there is no plan to show, or the plans cannot be read', async () => {
      const { viewer, api, view, reports } = follow({ pick: () => undefined });
      viewer.hass = liveHass(recorder().c);
      await vi.waitFor(() => expect(reports[0]).toMatchObject({ kind: 'none' }));
      expect(view.plan).toBeNull();
      vi.spyOn(api, 'listPlans').mockRejectedValue(new Error('offline'));
      api.emit({ plan_id: 'home', deleted: true });
      await vi.waitFor(() => expect(reports[1]).toMatchObject({ kind: 'error' }));
    });

    it('stops listening off the page and listens again on return', async () => {
      const { viewer, api, reports, lists } = follow();
      viewer.hass = liveHass(recorder().c);
      await vi.waitFor(() => expect(reports).toHaveLength(1));
      viewer.disconnect();
      await settle();
      api.emit({ plan_id: 'home', deleted: false });
      await settle();
      expect(lists).toHaveBeenCalledOnce();
      viewer.connect();
      await settle();
      api.emit({ plan_id: 'home', deleted: false });
      await vi.waitFor(() => expect(lists).toHaveBeenCalledTimes(2));
    });
  });

  describe('off the page', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('releases the view, the slider and the update notice, and rebuilds on return', async () => {
      const { viewer, view } = setup();
      const { c, ready } = recorder();
      viewer.hass = liveHass(c);
      expect(ready.size).toBe(1);
      await viewer.toggleTime();
      const dispose = vi.spyOn(view, 'dispose');
      const resume = vi.spyOn(view, 'resume');
      const pause = vi.spyOn(TimeBar.prototype, 'pause');

      viewer.disconnect();
      expect(dispose).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledOnce();
      expect(ready.size).toBe(0);

      viewer.connect();
      expect(resume).toHaveBeenCalledOnce();
      expect(ready.size).toBe(1);
    });
  });
});
