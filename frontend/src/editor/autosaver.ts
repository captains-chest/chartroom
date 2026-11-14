import type { Autosaver } from './models';

/** The page events `flushOnLeave` listens to (`window` in the browser). */
export interface Page extends EventTarget {
  readonly document: EventTarget & { readonly visibilityState: string };
}

/** How long to wait before each retry of a failed save; the last one repeats. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000, 30000];

export interface RetryOptions {
  /** Whether trying again can help, e.g. not when the server refused the value itself. */
  retryable?: (err: unknown) => boolean;
  /** Waits between retries (the last one repeats); defaults to `RETRY_DELAYS_MS`. */
  delaysMs?: readonly number[];
  /** A failure's text for the status; defaults to its `message`. */
  describe?: (err: unknown) => string;
}

/**
 * Saves the latest value a moment after the last change, one save at a time. `saved` is the value
 * as stored; `status` hears "Saved", "Unsaved changes", "Saving…" and failures (with `error`). A
 * failed save is tried again after a growing wait (through the same queue), unless `retryable`
 * says it can't succeed; `retry` tries at once, e.g. when the connection is back.
 */
export function autosaver<T>(
  save: (value: T) => Promise<void>,
  delayMs: number,
  saved: T,
  status: (text: string, error?: boolean) => void,
  {
    retryable = () => true,
    delaysMs = RETRY_DELAYS_MS,
    describe = (err) => String((err as Error | undefined)?.message ?? err),
  }: RetryOptions = {},
): Autosaver<T> {
  let latest = saved;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Failed saves in a row, picking the next wait. */
  let failures = 0;
  let disposed = false;
  // Flushes run one after another, so callers (the timer, Done, leaving the page) never write at
  // the same time; each saves whatever is latest once the one before it is done.
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let saving = false;
  const stopTimers = (): void => {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const once = async (): Promise<void> => {
    try {
      // This attempt replaces any retry still waiting, e.g. one a save queued before it set.
      clearTimeout(retryTimer);
      retryTimer = undefined;
      const value = latest;
      if (value === saved) return status('Saved');
      status('Saving…');
      saving = true;
      try {
        await save(value);
        saved = value;
        failures = 0;
        status(latest === value ? 'Saved' : 'Unsaved changes');
      } catch (err) {
        const text = `Save failed: ${describe(err)}`;
        if (disposed || !retryable(err)) {
          failures = 0;
          return status(text, true);
        }
        const wait = delaysMs[Math.min(failures++, delaysMs.length - 1)] ?? 0;
        status(`${text}. Retrying in ${Math.round(wait / 1000)} s…`, true);
        // A flush in the meantime (an edit, Done, leaving) tries sooner and clears this.
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void flush(), wait);
      } finally {
        saving = false;
      }
    } finally {
      queued--;
    }
  };
  const flush = (): Promise<void> => {
    stopTimers();
    // Start at once when nothing else is queued, so the save is sent before the page goes.
    return (queue = queued++ === 0 ? once() : queue.then(once));
  };
  return {
    schedule(value) {
      latest = value;
      status(value === saved ? 'Saved' : 'Unsaved changes');
      // An edit while a failed save waits to retry tries again at once, with the new value.
      const retrying = retryTimer !== undefined;
      stopTimers();
      if (retrying) void flush();
      else timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    retry() {
      if (retryTimer !== undefined) void flush();
    },
    dispose() {
      disposed = true;
      stopTimers();
    },
    get unsaved() {
      // A write in flight can still land over the latest value, e.g. after undoing back to it.
      return saving || latest !== saved;
    },
  };
}

/**
 * Save at once when the page is hidden or left (tab closed, reload, app switched away), since the
 * delay's timer never fires on an unloaded page, and ask before leaving while a change is still not
 * stored (`unsaved`, which may count more than the saver's own state). Returns a function that
 * stops listening.
 */
export function flushOnLeave(
  saver: Pick<Autosaver<unknown>, 'flush' | 'unsaved'>,
  page: Page = window,
): () => void {
  const flush = (): void => void saver.flush();
  const onVisibility = (): void => {
    if (page.document.visibilityState === 'hidden') flush();
  };
  const onBeforeUnload = (e: Event): void => {
    flush();
    // Still unsaved (just sent, or failing): let the browser ask "Leave site?".
    if (saver.unsaved) e.preventDefault();
  };
  page.addEventListener('pagehide', flush);
  page.addEventListener('beforeunload', onBeforeUnload);
  page.document.addEventListener('visibilitychange', onVisibility);
  return () => {
    page.removeEventListener('pagehide', flush);
    page.removeEventListener('beforeunload', onBeforeUnload);
    page.document.removeEventListener('visibilitychange', onVisibility);
  };
}
