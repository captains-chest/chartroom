import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ChartroomApi } from '../src/api';
import type { Hass } from '../src/ha-types';
import { MESH_REFRESH_MS } from '../src/mesh-layer';
import { emptyPlan } from '../src/plan/functions';
import { PlanView } from '../src/plan-view';
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

type Spy = ReturnType<typeof vi.fn>;
/** The stand-in behind `view.heat`. */
const fake = (heat: unknown): { dispose: Spy; setLayer: Spy; setHass: Spy; setPlan: Spy } =>
  heat as { dispose: Spy; setLayer: Spy; setHass: Spy; setPlan: Spy };

const topology = { nodes: [], links: [], sources: {} };

function viewWithMesh(): { view: PlanView; sent: () => number } {
  const mesh = vi.fn(async () => topology);
  const view = new PlanView(true);
  view.setApi(() => ({ mesh }) as unknown as ChartroomApi);
  view.setHass({ connection: {} } as unknown as Hass);
  return { view, sent: () => mesh.mock.calls.length };
}

describe('plan view lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops the mesh refresh when disposed, and starts it again on resume', async () => {
    const { view, sent } = viewWithMesh();
    await view.setMesh(true);
    const mesh = view.mesh!;
    expect(sent()).toBe(1);
    await vi.advanceTimersByTimeAsync(MESH_REFRESH_MS);
    expect(sent()).toBe(2);

    view.dispose();
    expect(view.mesh).toBeNull();
    expect(mesh.g.isConnected).toBe(false);
    await vi.advanceTimersByTimeAsync(3 * MESH_REFRESH_MS);
    expect(sent()).toBe(2);

    await view.resume();
    expect(view.meshOn).toBe(true);
    expect(view.mesh).not.toBe(mesh);
    expect(sent()).toBe(3);
    await vi.advanceTimersByTimeAsync(MESH_REFRESH_MS);
    expect(sent()).toBe(4);
  });

  it('shares one topology poll between views on a connection, until the last goes', async () => {
    const mesh = vi.fn(async () => topology);
    let api = { mesh } as unknown as ChartroomApi;
    const [a, b] = [new PlanView(true), new PlanView(true)];
    for (const v of [a, b]) {
      v.setApi(() => api);
      v.setHass({ connection: {} } as unknown as Hass);
    }
    await Promise.all([a.setMesh(true), b.setMesh(true)]);
    expect(mesh).toHaveBeenCalledOnce();
    expect(b.mesh!.note.textContent).toContain('no ZHA');
    await vi.advanceTimersByTimeAsync(MESH_REFRESH_MS);
    expect(mesh).toHaveBeenCalledTimes(2);

    a.dispose();
    await vi.advanceTimersByTimeAsync(MESH_REFRESH_MS);
    expect(mesh).toHaveBeenCalledTimes(3);
    // A new connection: the view moves to its poll, and the old one stops.
    const mesh2 = vi.fn(async () => topology);
    api = { mesh: mesh2 } as unknown as ChartroomApi;
    b.setHass({ connection: {} } as unknown as Hass);
    await vi.advanceTimersByTimeAsync(MESH_REFRESH_MS);
    expect(mesh2).toHaveBeenCalledTimes(2);
    b.dispose();
    await vi.advanceTimersByTimeAsync(3 * MESH_REFRESH_MS);
    expect(mesh).toHaveBeenCalledTimes(3);
    expect(mesh2).toHaveBeenCalledTimes(2);
  });

  it('disposes the heat layer, and builds a new one for the same layer on resume', async () => {
    const view = new PlanView(true);
    await view.setLayer('temperature');
    const heat = view.heat!;
    view.dispose();
    expect(fake(heat).dispose).toHaveBeenCalledOnce();
    expect(view.heat).toBeNull();
    expect(view.layer).toBe('temperature');

    await view.resume();
    expect(view.heat).not.toBeNull();
    expect(view.heat).not.toBe(heat);
    expect(fake(view.heat).setLayer).toHaveBeenCalledWith('temperature');
  });

  it('builds nothing while released, nor for a load that finishes after dispose', async () => {
    const view = new PlanView(true);
    const loading = view.setLayer('signal');
    view.dispose();
    await loading;
    expect(view.heat).toBeNull();

    await view.setMesh(true);
    await view.setLayer('humidity');
    expect(view.heat).toBeNull();
    expect(view.mesh).toBeNull();

    await view.resume();
    expect(fake(view.heat).setLayer).toHaveBeenCalledWith('humidity');
    expect(view.mesh).not.toBeNull();
  });

  it('resumes nothing when it was not disposed', async () => {
    const { view, sent } = viewWithMesh();
    await view.setMesh(true);
    const mesh = view.mesh;
    await view.resume();
    expect(view.mesh).toBe(mesh);
    expect(sent()).toBe(1);
  });
});

describe('plan view and Home Assistant states', () => {
  const state = (entity_id: string, s: string) => ({ entity_id, state: s, attributes: {} });
  const sensorPlan = (entity_id: string) => {
    const p = emptyPlan('Home');
    p.devices = [{ id: 't', entity_id, position: [1, 1] }];
    return p;
  };

  it('tells its layers only about states the plan reads', async () => {
    const view = new PlanView(true);
    view.setPlan(sensorPlan('sensor.t'));
    await view.setLayer('temperature');
    const heat = fake(view.heat);
    const h1: Hass = {
      states: { 'sensor.t': state('sensor.t', '20'), 'light.x': state('light.x', 'on') },
    };
    expect(view.setHass(h1)).toBe(true);
    expect(heat.setHass).toHaveBeenLastCalledWith(h1);
    const calls = heat.setHass.mock.calls.length;

    const h2: Hass = { ...h1, states: { ...h1.states, 'light.x': state('light.x', 'off') } };
    expect(view.setHass(h2)).toBe(false);
    expect(heat.setHass).toHaveBeenCalledTimes(calls);

    const h3: Hass = { ...h2, states: { ...h2.states, 'sensor.t': state('sensor.t', '21') } };
    expect(view.setHass(h3)).toBe(true);
    expect(heat.setHass).toHaveBeenLastCalledWith(h3);
  });

  it('hands a new plan the latest states, even ones skipped for the old plan', async () => {
    const view = new PlanView(true);
    view.setPlan(sensorPlan('sensor.t'));
    await view.setLayer('temperature');
    const heat = fake(view.heat);
    const h1: Hass = { states: { 'sensor.t': state('sensor.t', '20') } };
    view.setHass(h1);
    const h2: Hass = { states: { ...h1.states, 'sensor.u': state('sensor.u', '18') } };
    expect(view.setHass(h2)).toBe(false);

    const next = sensorPlan('sensor.u');
    view.setPlan(next);
    expect(heat.setPlan).toHaveBeenLastCalledWith(next, h2, false);
    view.setPlan(next, null, true);
    expect(heat.setPlan).toHaveBeenLastCalledWith(next, h2, true);
  });
});
