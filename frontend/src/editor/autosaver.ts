import type { Autosaver } from './models';

/** The page events `flushOnLeave` listens to (`window` in the browser). */
export interface Page extends EventTarget {
  readonly document: EventTarget & { readonly visibilityState: string };
}

/**
 * Saves the latest value a moment after the last change, one save at a time. `saved` is the value
 * as stored; `status` hears "Saved", "Unsaved changes", "Saving…" and failures (with `error`).
 */
export function autosaver<T>(
  save: (value: T) => Promise<void>,
  delayMs: number,
  saved: T,
  status: (text: string, error?: boolean) => void,
): Autosaver<T> {
  let latest = saved;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | null = null;
  const dispose = (): void => clearTimeout(timer);
  const flush = async (): Promise<void> => {
    dispose();
    if (saving) await saving;
    const value = latest;
    if (value === saved) return status('Saved');
    status('Saving…');
    saving = save(value).then(
      () => {
        saved = value;
        status(latest === value ? 'Saved' : 'Unsaved changes');
      },
      (err: unknown) => status(`Save failed: ${(err as Error).message ?? err}`, true),
    );
    await saving;
    saving = null;
  };
  return {
    schedule(value) {
      latest = value;
      status(value === saved ? 'Saved' : 'Unsaved changes');
      dispose();
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    dispose,
    get unsaved() {
      return latest !== saved;
    },
  };
}

/**
 * Save at once when the page is hidden or left (tab closed, reload, app switched away), since the
 * delay's timer never fires on an unloaded page, and ask before leaving while a change is still not
 * stored. Returns a function that stops listening.
 */
export function flushOnLeave(saver: Autosaver<unknown>, page: Page = window): () => void {
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
