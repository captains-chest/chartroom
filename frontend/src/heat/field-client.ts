// The main thread's side of the field worker (worker.ts, worker-protocol.ts).
import { workerUrl } from '../field-worker';
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from '../worker-protocol';

type Pending = { resolve: (r: WorkerResponse) => void };

/** Talks to the field worker; runs the same handler in this thread when workers are unavailable. */
export class FieldClient {
  #worker: Worker | null = null;
  #local: Promise<(req: WorkerRequest) => WorkerResponse> | null = null;
  #id = 0;
  readonly #pending = new Map<number, Pending>();

  constructor() {
    try {
      this.#worker = new Worker(workerUrl(), { type: 'module' });
      this.#worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
        const p = this.#pending.get(e.data.id);
        this.#pending.delete(e.data.id);
        p?.resolve(e.data);
      });
      this.#worker.addEventListener('error', () => this.#toLocal());
    } catch {
      this.#toLocal();
    }
  }

  #toLocal(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#local ??= import('../worker-protocol').then((m) => m.createHandler());
    // Requests in flight are lost with the worker: replay is not worth it, fail them.
    for (const [id, p] of this.#pending) p.resolve({ type: 'error', id, message: 'worker failed' });
    this.#pending.clear();
  }

  request(req: WorkerRequestBody): Promise<WorkerResponse> {
    const full = { ...req, id: ++this.#id } as WorkerRequest;
    if (!this.#worker) {
      this.#local ??= import('../worker-protocol').then((m) => m.createHandler());
      return this.#local.then((handle) => handle(full));
    }
    return new Promise((resolve) => {
      this.#pending.set(full.id, { resolve });
      this.#worker?.postMessage(full);
    });
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#pending.clear();
  }
}
