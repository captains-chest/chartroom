import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass, HassConnection } from '../src/ha-types';
import { emptyPlan, type Plan } from '../src/plan';
import { PlanView } from '../src/plan-view';
import { TimeBar } from '../src/time-bar';
import { ViewerController } from '../src/viewer';
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
    const plan = await viewer.load('home');
    expect(plan?.name).toBe('Home');
    expect(view.plan).toBe(plan);
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
    expect((await second)?.name).toBe('Other');
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
