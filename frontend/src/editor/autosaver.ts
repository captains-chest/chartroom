import type { Autosaver } from './models';

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
  const flush = async (): Promise<boolean> => {
    dispose();
    if (saving) await saving;
    const value = latest;
    if (value === saved) {
      status('Saved');
      return true;
    }
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
    return saved === latest;
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
  };
}
