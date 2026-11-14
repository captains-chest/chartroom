import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { autosaver } from '../src/editor/autosaver';

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
    expect(await second).toBe(true);
    expect(await s.flush()).toBe(true);
    expect(statuses.at(-1)).toBe('Saved');
  });

  it('shows a failed save as an error and tries again on the next change', async () => {
    const { s, saves, statuses, settle } = saver(true);
    s.schedule('b');
    const done = s.flush();
    settle();
    expect(await done).toBe(false);
    expect(statuses.at(-1)).toBe('!Save failed: offline');
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
