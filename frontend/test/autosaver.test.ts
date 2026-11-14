import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  autosaver,
  flushOnLeave,
  RETRY_DELAYS_MS,
  type Page,
  type RetryOptions,
} from '../src/editor/autosaver';

const DELAY = 600;

/** An Autosaver over strings whose saves wait for `settle`, recording saves and statuses. */
function saver(fail = false) {
  const saves: string[] = [];
  const statuses: string[] = [];
  let settle = (): void => {};
  const save = (v: string): Promise<void> =>
    new Promise((resolve, reject) => {
      saves.push(v);
      settle = () => (fail ? reject(new Error('offline')) : resolve());
    });
  const s = autosaver<string>(save, DELAY, 'a', (text, error) =>
    statuses.push(error ? `!${text}` : text),
  );
  return { s, saves, statuses, settle: () => settle() };
}

describe('Autosaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves the latest value once changes stop for the delay', async () => {
    const { s, saves, statuses, settle } = saver();
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    s.schedule('c');
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual(['c']);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['Unsaved changes', 'Unsaved changes', 'Saving…', 'Saved']);
  });

  it('reports a value back at the saved one as saved, without saving', async () => {
    const { s, saves, statuses } = saver();
    s.schedule('b');
    s.schedule('a');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saves).toEqual([]);
    expect(statuses).toEqual(['Unsaved changes', 'Saved', 'Saved']);
  });

  it('flushes at once, and waits for a save in flight before the next', async () => {
    const { s, saves, statuses, settle } = saver();
    s.schedule('b');
    const first = s.flush();
    expect(saves).toEqual(['b']);
    s.schedule('c');
    const second = s.flush();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saves).toEqual(['b']);
    settle();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(['b', 'c']);
    expect(statuses.slice(-2)).toEqual(['Unsaved changes', 'Saving…']);
    settle();
    await second;
    expect(statuses.at(-1)).toBe('Saved');
  });

  it('shows a failed save as an error and tries again on the next change', async () => {
    const { s, saves, statuses, settle } = saver(true);
    s.schedule('b');
    const done = s.flush();
    settle();
    await done;
    expect(statuses.at(-1)).toBe('!Save failed: offline. Retrying in 2 s…');
    s.schedule('c');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saves).toEqual(['b', 'c']);
  });

  it('drops a pending save on dispose', async () => {
    const { s, saves } = saver();
    s.schedule('b');
    s.dispose();
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(saves).toEqual([]);
  });
});

/**
 * An Autosaver over strings whose saves settle at once: they fail while `down` is set (with
 * `error`), and record each value sent and whether another was still in flight.
 */
function flaky(options?: RetryOptions) {
  const saves: string[] = [];
  const statuses: string[] = [];
  const state = { down: true, error: new Error('offline') as unknown, inFlight: 0, overlap: false };
  const save = async (v: string): Promise<void> => {
    saves.push(v);
    state.overlap ||= state.inFlight > 0;
    state.inFlight++;
    await Promise.resolve();
    state.inFlight--;
    if (state.down) throw state.error;
  };
  const s = autosaver<string>(
    save,
    DELAY,
    'a',
    (text, error) => statuses.push(error ? `!${text}` : text),
    options,
  );
  return { s, saves, statuses, state };
}

describe('Autosaver retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tries a failed save again after growing waits until it is stored', async () => {
    const { s, saves, statuses, state } = flaky();
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saves).toEqual(['b']);
    expect(statuses.at(-1)).toBe('!Save failed: offline. Retrying in 2 s…');
    expect(s.unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! - 1);
    expect(saves).toEqual(['b']);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual(['b', 'b']);
    expect(statuses.slice(-2)).toEqual(['Saving…', '!Save failed: offline. Retrying in 5 s…']);
    state.down = false;
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]!);
    expect(saves).toEqual(['b', 'b', 'b']);
    expect(statuses.at(-1)).toBe('Saved');
    expect(s.unsaved).toBe(false);
    // Stored: no more tries.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toHaveLength(3);
  });

  it('caps the wait at the last delay, and starts over after a save lands', async () => {
    const { s, saves, state } = flaky({ delaysMs: [100, 1000] });
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY + 100 + 1000 + 1000);
    expect(saves).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(saves).toHaveLength(4);
    state.down = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(5);
    state.down = true;
    s.schedule('c');
    await vi.advanceTimersByTimeAsync(DELAY + 100);
    expect(saves).toEqual(['b', 'b', 'b', 'b', 'b', 'c', 'c']);
  });

  it('does not retry an error that trying again cannot fix', async () => {
    const { s, saves, statuses, state } = flaky({
      retryable: (err) => (err as { code?: string }).code !== 'invalid_format',
      describe: (err) => (err as { message: string }).message,
    });
    state.error = { code: 'invalid_format', message: 'bad plan' };
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY + 60_000);
    expect(saves).toEqual(['b']);
    expect(statuses.at(-1)).toBe('!Save failed: bad plan');
    // Still not stored, so leaving still asks.
    expect(s.unsaved).toBe(true);
  });

  it('retries at once when asked (the connection is back), only while a retry waits', async () => {
    const { s, saves, statuses, state } = flaky();
    s.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([]);
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY);
    state.down = false;
    s.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(['b', 'b']);
    expect(statuses.at(-1)).toBe('Saved');
    s.retry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toEqual(['b', 'b']);
  });

  it('stops retrying on dispose, even for a save that fails afterwards', async () => {
    const { s, saves } = flaky();
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY);
    s.dispose();
    s.retry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toEqual(['b']);

    const late = flaky();
    late.s.schedule('b');
    const done = late.s.flush();
    late.s.dispose();
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late.saves).toEqual(['b']);
  });

  it("drops a retry once a later attempt in the queue starts, even if that one can't be retried", async () => {
    const saves: string[] = [];
    const errors: unknown[] = [new Error('offline'), { code: 'invalid_format', message: 'bad' }];
    const s = autosaver<string>(
      async (v) => {
        saves.push(v);
        await Promise.resolve();
        throw errors.shift();
      },
      DELAY,
      'a',
      () => {},
      { retryable: (err) => (err as { code?: string }).code !== 'invalid_format' },
    );
    s.schedule('b');
    void s.flush();
    s.schedule('c');
    void s.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves).toEqual(['b', 'c']);
  });

  it('saves at once on an edit while a failed save waits to retry', async () => {
    const { s, saves } = flaky();
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(saves).toEqual(['b']);
    s.schedule('c');
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(['b', 'c']);
  });

  it('sends retries through the same queue, one save at a time, with the latest value', async () => {
    const { s, saves, statuses, state } = flaky();
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY);
    // An edit and a leave while the retry waits: the retry is not sent on top of them.
    s.schedule('c');
    void s.flush();
    void s.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.overlap).toBe(false);
    expect(saves.slice(0, 2)).toEqual(['b', 'c']);
    expect(saves.every((v, i) => i === 0 || v === 'c')).toBe(true);
    state.down = false;
    s.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('Saved');
    expect(state.overlap).toBe(false);
  });
});

/** A stand-in for `window`: page events, and a document that can be hidden. */
function page() {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const hide = (): void => {
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  };
  /** Whether the browser would ask before leaving. */
  const beforeUnload = (): boolean => {
    const e = new Event('beforeunload', { cancelable: true });
    p.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const p: Page = Object.assign(new EventTarget(), { document });
  return { p, hide, beforeUnload };
}

describe('flushOnLeave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves a change still waiting for the delay when the page is hidden or unloaded', async () => {
    const { p, hide } = page();
    const { s, saves, settle } = saver();
    flushOnLeave(s, p);
    s.schedule('b');
    hide();
    expect(saves).toEqual(['b']);
    settle();
    s.schedule('c');
    p.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(['b', 'c']);
  });

  it('ignores the page becoming visible, and nothing to save', () => {
    const { p, hide } = page();
    const { s, saves } = saver();
    flushOnLeave(s, p);
    p.document.dispatchEvent(new Event('visibilitychange'));
    s.schedule('b');
    p.document.dispatchEvent(new Event('visibilitychange'));
    expect(saves).toEqual([]);
    s.schedule('a');
    hide();
    expect(saves).toEqual([]);
  });

  it('asks before leaving only while a change is not stored', async () => {
    const { p, beforeUnload } = page();
    const { s, saves, settle } = saver(true);
    flushOnLeave(s, p);
    expect(beforeUnload()).toBe(false);
    s.schedule('b');
    // Sent at once, but not stored yet.
    expect(beforeUnload()).toBe(true);
    expect(saves).toEqual(['b']);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    // The save failed: still ask, and try again.
    expect(s.unsaved).toBe(true);
    expect(beforeUnload()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(['b', 'b']);
  });

  it('never writes twice at once when several leave events overlap', async () => {
    const { p, hide } = page();
    const { s, saves, settle } = saver();
    flushOnLeave(s, p);
    s.schedule('b');
    hide();
    s.schedule('c');
    hide();
    p.dispatchEvent(new Event('pagehide'));
    expect(saves).toEqual(['b']);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(['b', 'c']);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual(['b', 'c']);
    expect(s.unsaved).toBe(false);
  });

  it('asks before leaving while a save is in flight, even back at the stored value', async () => {
    const { p, beforeUnload } = page();
    const { s, settle } = saver();
    flushOnLeave(s, p);
    s.schedule('b');
    const stored = s.flush();
    settle();
    await stored;
    s.schedule('c');
    void s.flush();
    // Undo back to the stored 'b' while 'c' is still being written.
    s.schedule('b');
    expect(beforeUnload()).toBe(true);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(beforeUnload()).toBe(false);
  });

  it('keeps asking before leaving while a failed save waits to retry, and stops once stored', async () => {
    const { p, beforeUnload } = page();
    const { s, state } = flaky();
    flushOnLeave(s, p);
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(beforeUnload()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    state.down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beforeUnload()).toBe(false);
  });

  it('stops listening when stopped', () => {
    const { p, hide, beforeUnload } = page();
    const { s, saves } = saver();
    flushOnLeave(s, p)();
    s.schedule('b');
    hide();
    p.dispatchEvent(new Event('pagehide'));
    expect(beforeUnload()).toBe(false);
    expect(saves).toEqual([]);
  });
});
