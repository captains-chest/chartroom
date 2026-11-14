import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { autosaver, flushOnLeave, type Page } from '../src/editor/autosaver';

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
