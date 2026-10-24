/** Messages between the main thread and the field worker (heatmaps arrive in Phase 3). */
export type WorkerRequest =
  | { type: 'ping'; id: number }
  | { type: 'field'; id: number; size: number };

export type WorkerResponse =
  | { type: 'pong'; id: number; version: string }
  | { type: 'field'; id: number; size: number; values: Float32Array }
  | { type: 'error'; id: number; message: string };

export const WORKER_VERSION = '0';
export const MAX_FIELD_SIZE = 1024;

/** Pure request handler, so it can be unit tested without a Worker. */
export function handleRequest(req: WorkerRequest): WorkerResponse {
  switch (req.type) {
    case 'ping':
      return { type: 'pong', id: req.id, version: WORKER_VERSION };
    case 'field': {
      if (!Number.isInteger(req.size) || req.size < 1 || req.size > MAX_FIELD_SIZE) {
        return { type: 'error', id: req.id, message: `size must be 1..${MAX_FIELD_SIZE}` };
      }
      return {
        type: 'field',
        id: req.id,
        size: req.size,
        values: new Float32Array(req.size * req.size),
      };
    }
  }
}
