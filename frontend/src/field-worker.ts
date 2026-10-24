import type { WorkerResponse } from './worker-protocol';

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

/** Start the background worker and resolve once it answers a ping. */
export function pingWorker(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker timeout'));
    }, timeoutMs);
    worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => {
      clearTimeout(timer);
      worker.terminate();
      if (e.data.type === 'pong') resolve(e.data.version);
      else reject(new Error('unexpected worker reply'));
    });
    worker.addEventListener('error', (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(e.message || 'worker error'));
    });
    worker.postMessage({ type: 'ping', id: 1 });
  });
}
