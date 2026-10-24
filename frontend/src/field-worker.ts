import type { WorkerResponse } from './worker-protocol';

/** Start the background worker and resolve once it answers a ping. */
export function pingWorker(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
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
