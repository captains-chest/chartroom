import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { HassConnection } from '../src/ha-types';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { PlanEditor } from '../src/plan-editor';
import { PlanView } from '../src/plan-view';
import { installFakeDom } from './fake-dom';

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

const key = (k: string) => ({ key: k, composedPath: () => [] }) as unknown as KeyboardEvent;
const click = (x: number) =>
  ({ button: 0, clientX: x * 100, clientY: 0, target: null }) as unknown as PointerEvent;

/** A connection that can drop: saves fail while it is down, and `ready` fires when it is back. */
function connection() {
  const target = new EventTarget();
  let up = true;
  const conn = {
    sendMessagePromise: () => Promise.reject(new Error('unused')),
    addEventListener: (e: 'ready', l: () => void) => target.addEventListener(e, l),
    removeEventListener: (e: 'ready', l: () => void) => target.removeEventListener(e, l),
  } satisfies HassConnection;
  return {
    conn,
    drop: () => (up = false),
    reconnect: () => {
      up = true;
      target.dispatchEvent(new Event('ready'));
    },
    save: async (): Promise<void> => {
      if (!up)
        throw { type: 'result', success: false, error: { code: 3, message: 'Connection lost' } };
    },
  };
}

function editor(save: (plan: Plan) => Promise<void>, conn?: HassConnection) {
  const view = new PlanView(true);
  const plan = emptyPlan('Home');
  view.setPlan(plan);
  const saves: Plan[] = [];
  const e = new PlanEditor({
    view,
    hass: () => (conn ? { connection: conn } : undefined),
    save: async (p) => {
      saves.push(p);
      await save(p);
    },
    planId: 'home',
    plan,
  });
  /** Draw one wall with the Wall tool. */
  const drawWall = (): void => {
    e.key(key('w'));
    view.delegate!.down([0, 0], click(0));
    view.delegate!.up([0, 0], click(0));
    view.delegate!.down([3, 0], click(3));
    view.delegate!.up([3, 0], click(3));
    e.key(key('Escape'));
  };
  const status = (): string => (e.toolbar as unknown as { textContent: string }).textContent;
  return { e, saves, drawWall, status };
}

describe('editor saving', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tries a save that failed on a lost connection again as soon as it is back', async () => {
    const c = connection();
    const { e, saves, drawWall } = editor(c.save, c.conn);
    c.drop();
    drawWall();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(1);
    expect(e.plan.walls).toHaveLength(1);
    c.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toBe(e.plan);
    // Saved: nothing more to retry.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toHaveLength(2);
  });

  it('does not retry a plan Home Assistant refused, nor after closing', async () => {
    const { saves, drawWall } = editor(() =>
      Promise.reject({ code: 'invalid_format', message: 'bad plan' }),
    );
    drawWall();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toHaveLength(1);

    const c = connection();
    const lost = editor(c.save, c.conn);
    c.drop();
    lost.drawWall();
    await lost.e.close();
    expect(lost.saves).toHaveLength(1);
    c.reconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lost.saves).toHaveLength(1);
  });
});
