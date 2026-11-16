// The main thread's side of the field worker (worker.ts, worker-protocol.ts).
import { workerUrl } from '../field-worker';
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from '../worker-protocol';

type Pending = { req: WorkerRequest; resolve: (r: WorkerResponse) => void };
type Waiting = { req: WorkerRequestBody; resolve: (r: WorkerResponse) => void };

/** What a request replaced in its lane by a later one settles with. */
export const SUPERSEDED = 'superseded';

const spawnWorker = (): Worker => new Worker(workerUrl(), { type: 'module' });

/**
 * Talks to the field worker; runs the same handler in this thread when workers are unavailable.
 * Every request settles: failures come back as `error` replies, never as rejections.
 */
export class FieldClient {
  #worker: Worker | null = null;
  #handler: Promise<(req: WorkerRequest) => WorkerResponse> | null = null;
  #id = 0;
  readonly #pending = new Map<number, Pending>();
  /** Per lane: the request waiting for the one in flight to finish (null: none waiting). */
  readonly #lanes = new Map<string, Waiting | null>();

  constructor(spawn = spawnWorker) {
    try {
      const worker = spawn();
      worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const p = this.#pending.get(e.data.id);
        this.#pending.delete(e.data.id);
        p?.resolve(e.data);
      });
      worker.addEventListener('error', () => this.#toLocal());
      this.#worker = worker;
    } catch {
      // No module workers here: every request runs in this thread.
    }
  }

  /** The worker failed: its requests in flight, and all later ones, run in this thread. */
  #toLocal(): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const p of this.#pending.values()) void this.#local(p.req).then(p.resolve);
    this.#pending.clear();
  }

  #local(req: WorkerRequest): Promise<WorkerResponse> {
    this.#handler ??= import('../worker-protocol').then((m) => m.createHandler());
    return this.#handler
      .then((handle) => handle(req))
      .catch((e: unknown) => ({ type: 'error', id: req.id, message: String(e) }));
  }

  /**
   * Run `req`. In a `lane`, at most one request is in flight and one waits: a later request takes
   * the waiting one's place, which settles at once as an `error` reply saying SUPERSEDED. So a
   * drag asking for a new layout per move costs the worker two plans, not one per move.
   */
  request(req: WorkerRequestBody, lane?: string): Promise<WorkerResponse> {
    if (lane === undefined) return this.#send(req);
    if (!this.#lanes.has(lane)) return this.#run(lane, req);
    this.#lanes.get(lane)?.resolve({ type: 'error', id: 0, message: SUPERSEDED });
    return new Promise((resolve) => this.#lanes.set(lane, { req, resolve }));
  }

  #run(lane: string, req: WorkerRequestBody): Promise<WorkerResponse> {
    this.#lanes.set(lane, null);
    const reply = this.#send(req);
    void reply.then(() => {
      const next = this.#lanes.get(lane);
      if (next) void this.#run(lane, next.req).then(next.resolve);
      else this.#lanes.delete(lane);
    });
    return reply;
  }

  #send(req: WorkerRequestBody): Promise<WorkerResponse> {
    const full = { ...req, id: ++this.#id } as WorkerRequest;
    const worker = this.#worker;
    if (!worker) return this.#local(full);
    return new Promise((resolve) => {
      this.#pending.set(full.id, { req: full, resolve });
      worker.postMessage(full);
    });
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#pending.clear();
    this.#lanes.clear();
  }
}
