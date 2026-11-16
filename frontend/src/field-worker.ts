// The page's one field worker (worker.ts, worker-protocol.ts), shared by every view: the panel and
// each card's heatmap. It starts with the first view and stops when the last one goes.
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from './worker-protocol';

/**
 * The worker script. It is a build entry of its own (vite.config.ts) that shares its code with the
 * in-page fallback's lazy import, so the field code ships once. Entries sit at the root of the
 * static folder and chunks under chunks/, so the path depends on which file this code lands in.
 */
export const workerUrl = (): URL =>
  new URL(
    `${import.meta.url.includes('/chunks/') ? '../' : './'}workers/worker.js`,
    import.meta.url,
  );

const spawnWorker = (): Worker => new Worker(workerUrl(), { type: 'module' });

type Handler = (req: WorkerRequest) => WorkerResponse;
type Pending = { view: number; req: WorkerRequest; resolve: (r: WorkerResponse) => void };

/** One view's line to the shared worker. */
export interface FieldLine {
  /** Every request settles: failures come back as `error` replies, never as rejections. */
  send(req: WorkerRequestBody): Promise<WorkerResponse>;
  /** The view is gone: its requests in flight are dropped, and its layout forgotten. */
  close(): void;
}

/**
 * A field worker shared by the views open on it. Requests carry the view's number, so each view
 * keeps its own layout in the worker. When workers are unavailable, or the worker fails, requests
 * run in this thread instead: those in flight too, after each view's layout is set up again.
 */
export class FieldWorker {
  #worker: Worker | null = null;
  #handler: Promise<Handler> | null = null;
  #open = 0;
  #views = 0;
  #id = 0;
  readonly #pending = new Map<number, Pending>();
  /** Each view's last layout request, to set it up again in this thread if the worker fails. */
  readonly #layouts = new Map<number, WorkerRequest>();

  readonly #spawn: () => Worker;

  constructor(spawn: () => Worker = spawnWorker) {
    this.#spawn = spawn;
  }

  /** Whether requests go to a worker thread (false: they run in this thread). */
  get threaded(): boolean {
    return this.#worker !== null;
  }

  open(): FieldLine {
    if (this.#open++ === 0) this.#start();
    const view = ++this.#views;
    let closed = false;
    return {
      send: (req) => this.#send(view, req),
      close: () => {
        if (closed) return;
        closed = true;
        this.#close(view);
      },
    };
  }

  #start(): void {
    try {
      const worker = this.#spawn();
      worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const p = this.#pending.get(e.data.id);
        this.#pending.delete(e.data.id);
        p?.resolve(e.data);
      });
      worker.addEventListener('error', () => {
        if (worker === this.#worker) this.#toLocal();
      });
      this.#worker = worker;
    } catch {
      // No module workers here: every request runs in this thread.
    }
  }

  #close(view: number): void {
    for (const [id, p] of this.#pending) if (p.view === view) this.#pending.delete(id);
    this.#layouts.delete(view);
    if (--this.#open > 0) {
      void this.#send(view, { type: 'drop', view });
      return;
    }
    this.#worker?.terminate();
    this.#worker = null;
    this.#handler = null;
    this.#pending.clear();
  }

  /** The worker failed: its requests in flight, and all later ones, run in this thread. */
  #toLocal(): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const req of this.#layouts.values()) if (!this.#pending.has(req.id)) void this.#local(req);
    this.#layouts.clear();
    for (const p of this.#pending.values()) void this.#local(p.req).then(p.resolve);
    this.#pending.clear();
  }

  #local(req: WorkerRequest): Promise<WorkerResponse> {
    this.#handler ??= import('./worker-protocol').then((m) => m.createHandler());
    return this.#handler
      .then((handle) => handle(req))
      .catch((e: unknown) => ({ type: 'error', id: req.id, message: String(e) }));
  }

  #send(view: number, body: WorkerRequestBody): Promise<WorkerResponse> {
    const req = { ...body, id: ++this.#id, view } as WorkerRequest;
    const worker = this.#worker;
    if (!worker) return this.#local(req);
    if (req.type === 'mesh') this.#layouts.set(view, req);
    return new Promise((resolve) => {
      this.#pending.set(req.id, { view, req, resolve });
      worker.postMessage(req);
    });
  }
}

/** The page's field worker. */
export const fieldWorker = new FieldWorker();

/**
 * Hold the page's field worker (the panel does while on the page, so its heatmap finds it
 * running) and ask whether it answers: `ready` resolves with its version, and rejects when
 * requests run in this thread or it does not answer within `timeoutMs`.
 */
export function holdWorker(timeoutMs = 5000): { ready: Promise<string>; release: () => void } {
  const line = fieldWorker.open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('worker timeout')), timeoutMs);
    void line.send({ type: 'ping' }).then((res) => {
      clearTimeout(timer);
      if (res.type === 'pong' && fieldWorker.threaded) resolve(res.version);
      else reject(new Error('worker unavailable'));
    });
  });
  // Released, it says nothing more (a ping in flight is dropped with the line).
  const release = (): void => {
    clearTimeout(timer);
    line.close();
  };
  return { ready, release };
}
