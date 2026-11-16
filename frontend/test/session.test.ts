import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Page } from '../src/editor/autosaver';
import { EditSession, SAVE_DELAY_MS } from '../src/editor/session';
import type { HassConnection } from '../src/ha-types';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { FakeEventTarget } from './fake-dom';

const WAIT = 1000;

/** A session over a page and a connection the test controls, recording saves and statuses. */
function setup(save: (plan: Plan) => Promise<void> = async () => {}) {
  const page = Object.assign(new FakeEventTarget(), {
    document: Object.assign(new FakeEventTarget(), { visibilityState: 'visible' }),
  });
  const ready = new Set<() => void>();
  const connection: HassConnection = {
    sendMessagePromise: async () => undefined as never,
    addEventListener: (_e, fn) => ready.add(fn),
    removeEventListener: (_e, fn) => ready.delete(fn),
  };
  const saves: Plan[] = [];
  const statuses: string[] = [];
  const session = new EditSession({
    plan: emptyPlan('Home'),
    save: async (p) => {
      saves.push(p);
      await save(p);
    },
    status: (text, error) => void statuses.push(error ? `!${text}` : text),
    connection,
    page: page as unknown as Page,
    closeWaitMs: WAIT,
  });
  const leaveAsks = (): boolean => {
    const e = new Event('beforeunload', { cancelable: true });
    page.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { session, saves, statuses, page, ready, leaveAsks };
}

const renamed = (p: Plan, name: string): Plan => ({ ...p, name });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('edit session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits, undoes and redoes, and saves a moment after the last change', async () => {
    const { session, saves } = setup();
    const first = session.plan;
    expect(session.commit(first)).toBe(false);
    expect(session.commit(renamed(first, 'A'))).toBe(true);
    expect(session.commit(renamed(session.plan, 'B'))).toBe(true);
    expect([session.canUndo, session.canRedo]).toEqual([true, false]);
    expect(session.undo()).toBe(true);
    expect(session.plan.name).toBe('A');
    expect(session.redo()).toBe(true);
    expect(session.redo()).toBe(false);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(saves.map((p) => p.name)).toEqual(['B']);
  });

  it('retries a failed save at once when Home Assistant is back', async () => {
    let up = false;
    const { session, saves, ready } = setup(async () => {
      if (!up) throw { code: 3, message: 'Connection lost' };
    });
    session.commit(renamed(session.plan, 'A'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(saves).toHaveLength(1);
    up = true;
    for (const fn of ready) fn();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toHaveLength(2);
  });

  it('counts an import as unsaved work until it ends', async () => {
    const { session, leaveAsks } = setup();
    const job = deferred<string | null>();
    session.track(job.promise);
    expect(leaveAsks()).toBe(true);
    job.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(leaveAsks()).toBe(false);
  });

  it('waits at close for imports, then saves, stops listening and takes no more changes', async () => {
    const { session, saves, statuses, page, ready } = setup();
    const job = deferred<string | null>();
    session.track(job.promise);
    session.commit(renamed(session.plan, 'A'));
    let result: string | null | undefined;
    const closing = session.close().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(WAIT / 2);
    expect(result).toBeUndefined();
    expect(statuses.at(-1)).toBe('Uploading image…');
    // The import lands a change while close waits for it.
    expect(session.commit(renamed(session.plan, 'B'))).toBe(true);
    job.resolve(null);
    await closing;
    expect(result).toBeNull();
    expect(saves.map((p) => p.name)).toEqual(['B']);
    expect(session.closed).toBe(true);
    expect(session.commit(renamed(session.plan, 'C'))).toBe(false);
    expect(session.undo()).toBe(false);
    expect(page.listening('beforeunload')).toBe(0);
    expect(ready.size).toBe(0);
  });

  it('says why an import it waited for failed', async () => {
    const { session } = setup();
    session.track(Promise.resolve('The underlay image was not imported: upload failed (500)'));
    session.track(Promise.reject(new Error('boom')));
    expect(await session.close()).toBe(
      'The underlay image was not imported: upload failed (500) Import failed: boom',
    );
  });

  it('stops waiting for a stuck upload, aborts it and says so (#65)', async () => {
    const { session, saves } = setup();
    session.commit(renamed(session.plan, 'A'));
    session.track(new Promise(() => {}));
    let result: string | null | undefined;
    void session.close().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(result).toBeUndefined();
    expect(session.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.signal.aborted).toBe(true);
    expect(result).toBe(
      'The underlay image was still uploading and was dropped: it took too long.',
    );
    expect(saves.map((p) => p.name)).toEqual(['A']);
  });

  it('says when the last change could not be saved at close (#66)', async () => {
    const { session, statuses } = setup(async () => {
      throw { code: 3, message: 'Connection lost' };
    });
    session.commit(renamed(session.plan, 'A'));
    expect(await session.close()).toBe('Your last change was not saved: Connection lost.');
    // Not retried once closed.
    const before = statuses.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses).toHaveLength(before);
  });

  it('says nothing at close when the last save went through', async () => {
    const { session } = setup();
    session.commit(renamed(session.plan, 'A'));
    expect(await session.close()).toBeNull();
  });
});
