// A heat layer's side of the page's field worker (field-worker.ts).
import { fieldWorker, type FieldLine, type FieldWorker } from '../field-worker';
import type { WorkerRequestBody, WorkerResponse } from '../worker-protocol';

type Waiting = { req: WorkerRequestBody; resolve: (r: WorkerResponse) => void };

/** What a request replaced in its lane by a later one settles with. */
export const SUPERSEDED = 'superseded';

/**
 * One view's requests to the shared field worker. Every request settles: failures come back as
 * `error` replies, never as rejections.
 */
export class FieldClient {
  readonly #line: FieldLine;
  /** Per lane: the request waiting for the one in flight to finish (null: none waiting). */
  readonly #lanes = new Map<string, Waiting | null>();

  constructor(worker: FieldWorker = fieldWorker) {
    this.#line = worker.open();
  }

  /**
   * Run `req`. In a `lane`, at most one request is in flight and one waits: a later request takes
   * the waiting one's place, which settles at once as an `error` reply saying SUPERSEDED. So a
   * drag asking for a new layout per move costs the worker two plans, not one per move.
   */
  request(req: WorkerRequestBody, lane?: string): Promise<WorkerResponse> {
    if (lane === undefined) return this.#line.send(req);
    if (!this.#lanes.has(lane)) return this.#run(lane, req);
    this.#lanes.get(lane)?.resolve({ type: 'error', id: 0, message: SUPERSEDED });
    return new Promise((resolve) => this.#lanes.set(lane, { req, resolve }));
  }

  #run(lane: string, req: WorkerRequestBody): Promise<WorkerResponse> {
    this.#lanes.set(lane, null);
    const reply = this.#line.send(req);
    void reply.then(() => {
      const next = this.#lanes.get(lane);
      if (next) void this.#run(lane, next.req).then(next.resolve);
      else this.#lanes.delete(lane);
    });
    return reply;
  }

  dispose(): void {
    this.#line.close();
    this.#lanes.clear();
  }
}
