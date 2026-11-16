// An editing session, without the DOM: the plan's history, saving it (a moment after each change,
// at once when the page goes, again after a failure or when Home Assistant is back), the imports
// still running, and closing, which waits for those imports and the last save. The editor
// (plan-editor.ts) draws it and turns clicks into commits.
import { errorText, retryable } from '../ha-errors';
import type { HassConnection } from '../ha-types';
import { History } from '../history';
import type { Plan } from '../plan/models';
import { autosaver, flushOnLeave, type Page } from './autosaver';
import type { Autosaver } from './models';

/** Autosave this long after the last change. */
export const SAVE_DELAY_MS = 600;
/** How long Done waits for an image still uploading before it drops the upload and closes. */
export const CLOSE_WAIT_MS = 60_000;

export interface SessionHost {
  /** The plan as stored when the session starts. */
  plan: Plan;
  save(plan: Plan): Promise<void>;
  /** The save state for the toolbar: "Saved", "Saving…", a failure (`error`)… */
  status(text: string, error: boolean): void;
  /** Whose reconnects retry a failed save at once. */
  connection?: HassConnection | undefined;
  /** Where leaving is watched (`window` by default). */
  page?: Page;
  saveDelayMs?: number;
  closeWaitMs?: number;
}

export class EditSession {
  readonly #history: History<Plan>;
  readonly #saver: Autosaver<Plan>;
  readonly #status: SessionHost['status'];
  readonly #closeWaitMs: number;
  /**
   * Imports still running (an image may be uploading), each ending with why it failed, or null.
   * Leaving the page asks first while one runs, and close() waits for them.
   */
  readonly #imports = new Set<Promise<string | null>>();
  /** Aborts uploads still running when close() stops waiting for them. */
  readonly #abort = new AbortController();
  readonly #stopLeaveGuard: () => void;
  readonly #connection: HassConnection | undefined;
  readonly #onReconnect = (): void => this.#saver.retry();
  /** Why the last save failed, while the plan is not stored. */
  #saveError: string | null = null;
  #closed = false;

  constructor(host: SessionHost) {
    this.#history = new History(host.plan);
    this.#status = (text, error) => host.status(text, error);
    this.#closeWaitMs = host.closeWaitMs ?? CLOSE_WAIT_MS;
    this.#saver = autosaver(
      async (plan) => {
        await host.save(plan);
        this.#saveError = null;
      },
      host.saveDelayMs ?? SAVE_DELAY_MS,
      host.plan,
      (text, error) => host.status(text, !!error),
      {
        retryable,
        describe: (err) => (this.#saveError = errorText(err)),
      },
    );
    const saver = this.#saver;
    const imports = this.#imports;
    // An image still uploading is unsaved work too: the plan does not point at it yet.
    this.#stopLeaveGuard = flushOnLeave(
      {
        flush: () => saver.flush(),
        get unsaved() {
          return saver.unsaved || imports.size > 0;
        },
      },
      host.page,
    );
    // Home Assistant's connection is back: try a failed save now rather than after its wait.
    this.#connection = host.connection;
    this.#connection?.addEventListener?.('ready', this.#onReconnect);
  }

  get plan(): Plan {
    return this.#history.present;
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  /**
   * Set once close() has begun (the final save is under way): the plan no longer changes, since a
   * later edit would be saved after close, maybe as another plan once the panel moves on.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /** A change is not stored yet (after close: its last save failed). */
  get unsaved(): boolean {
    return this.#saver.unsaved;
  }

  /** For uploads: aborted when close() stops waiting for them. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** Make `next` the plan and save it soon. Whether it changed anything. */
  commit(next: Plan): boolean {
    if (this.#closed || !this.#history.commit(next)) return false;
    this.#saver.schedule(this.plan);
    return true;
  }

  undo(): boolean {
    if (this.#closed || this.#history.undo() === undefined) return false;
    this.#saver.schedule(this.plan);
    return true;
  }

  redo(): boolean {
    if (this.#closed || this.#history.redo() === undefined) return false;
    this.#saver.schedule(this.plan);
    return true;
  }

  /** Count an import as running until it ends; it resolves to why it failed, or null. */
  track(job: Promise<string | null>): void {
    this.#imports.add(job);
    const done = (): void => void this.#imports.delete(job);
    job.then(done, done);
  }

  /** Save any pending change now, without closing (the panel left the page). */
  flush(): Promise<void> {
    return this.#saver.flush();
  }

  /**
   * Wait for imports still running, so an image being uploaded lands in the plan (but at most
   * `closeWaitMs`: then the uploads are aborted), then save what is pending and stop. Resolves to
   * what went wrong that the user would otherwise not see once the editor is gone: an import that
   * failed or was dropped, or a last change that could not be saved. Null when nothing did.
   */
  async close(): Promise<string | null> {
    const problems: string[] = [];
    const deadline = Date.now() + this.#closeWaitMs;
    // Another import may start meanwhile: the editor stays usable until they are all done.
    while (this.#imports.size > 0) {
      this.#status('Uploading image…', false);
      const left = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(
        (r) => (timer = setTimeout(() => r('timeout'), Math.max(0, left))),
      );
      const settled = await Promise.race([Promise.allSettled(this.#imports), timeout]);
      clearTimeout(timer);
      if (settled === 'timeout') {
        this.#abort.abort(new Error('took too long'));
        problems.push('The underlay image was still uploading and was dropped: it took too long.');
        break;
      }
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) problems.push(r.value);
        else if (r.status === 'rejected')
          problems.push(`Import failed: ${(r.reason as Error)?.message ?? r.reason}`);
      }
    }
    this.#closed = true;
    this.#stopLeaveGuard();
    this.#connection?.removeEventListener?.('ready', this.#onReconnect);
    await this.#saver.flush();
    // A failed last save is not retried once closed: the panel may move on to another plan. So say
    // so, rather than let the failure go with the editor's toolbar.
    if (this.#saver.unsaved)
      problems.push(
        `Your last change was not saved${this.#saveError ? `: ${this.#saveError}` : ''}.`,
      );
    this.#saver.dispose();
    return problems.length > 0 ? problems.join(' ') : null;
  }
}
