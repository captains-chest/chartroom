import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { MESH_REFRESH_MS } from '../src/mesh-layer';
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
const fake = (heat: unknown): { dispose: Spy; setLayer: Spy } =>
  heat as { dispose: Spy; setLayer: Spy };

const topology = { nodes: [], links: [], sources: {} };

function viewWithMesh(): { view: PlanView; sent: () => number } {
  const send = vi.fn(async () => topology);
  const view = new PlanView(true);
  view.setHass({ connection: { sendMessagePromise: send } } as unknown as Hass);
  return { view, sent: () => send.mock.calls.length };
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
