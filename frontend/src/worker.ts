/// <reference lib="webworker" />
import { createHandler, type WorkerRequest } from './worker-protocol';

declare const self: DedicatedWorkerGlobalScope;

const handle = createHandler();
self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  let res;
  try {
    res = handle(event.data);
  } catch (e) {
    res = { type: 'error' as const, id: event.data.id, message: String(e) };
  }
  if (res.type === 'field') self.postMessage(res, [res.field.buffer]);
  else self.postMessage(res);
});
