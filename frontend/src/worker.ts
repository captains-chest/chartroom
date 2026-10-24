/// <reference lib="webworker" />
import { handleRequest, type WorkerRequest } from './worker-protocol';

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const res = handleRequest(event.data);
  if (res.type === 'field') self.postMessage(res, [res.values.buffer]);
  else self.postMessage(res);
});
