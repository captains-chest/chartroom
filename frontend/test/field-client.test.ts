import { describe, expect, it, vi } from 'vite-plus/test';
import { fieldGrid } from '../src/field';
import type { Point } from '../src/plan/types';
import { CanvasRenderer } from '../src/heat/canvas-renderer';
import { FieldWorker } from '../src/field-worker';
import { FieldClient, SUPERSEDED } from '../src/heat/field-client';
import type { Layout } from '../src/heat/models';
import {
  createHandler,
  type WorkerRequest,
  type WorkerRequestBody,
  type WorkerResponse,
} from '../src/worker-protocol';

const grid = fieldGrid({ minX: 0, minY: 0, maxX: 4, maxY: 3 }, 1, 16);
const sensors: Point[] = [
  [0, 0],
  [4, 0],
  [2, 3],
];
const mesh: WorkerRequestBody = { type: 'mesh', key: 'k', sensors, outline: [], grid };

/** A stand-in for the module worker that records what it was sent. */
class FakeWorker extends EventTarget {
  readonly sent: WorkerRequest[] = [];
  postMessage(req: WorkerRequest): void {
    this.sent.push(req);
  }
  terminate(): void {}
  reply(res: WorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data: res }));
  }
}

const withWorker = (): [FieldClient, FakeWorker] => {
  const worker = new FakeWorker();
  return [new FieldClient(new FieldWorker(() => worker as unknown as Worker)), worker];
};
const noWorkers = (): FieldClient =>
  new FieldClient(
    new FieldWorker(() => {
      throw new Error('no workers');
    }),
  );

/** A stand-in worker that answers with the real handler. */
class HandlerWorker extends FakeWorker {
  readonly handle = createHandler();
  terminated = false;
  override postMessage(req: WorkerRequest): void {
    super.postMessage(req);
    queueMicrotask(() => this.reply(this.handle(req)));
  }
  override terminate(): void {
    this.terminated = true;
  }
}

describe('field client', () => {
  it('runs requests in this thread when there are no workers', async () => {
    const client = noWorkers();
    expect((await client.request(mesh)).type).toBe('mesh');
    expect((await client.request({ type: 'values', key: 'k', values: [1, 2, 3] })).type).toBe(
      'field',
    );
  });

  it('turns a handler that throws into an error reply', async () => {
    const client = noWorkers();
    await client.request(mesh);
    const bad = { type: 'values', key: 'k', values: null } as unknown as WorkerRequestBody;
    expect((await client.request(bad)).type).toBe('error');
  });

  it('shares one worker between views, each with its own layout, until the last goes', async () => {
    const worker = new HandlerWorker();
    const spawn = vi.fn(() => worker as unknown as Worker);
    const shared = new FieldWorker(spawn);
    const a = new FieldClient(shared);
    const b = new FieldClient(shared);
    await a.request(mesh);
    await b.request({ ...mesh, key: 'k2', sensors: [...sensors, [4, 3]] } as WorkerRequestBody);
    expect(await a.request({ type: 'values', key: 'k', values: [1, 2, 3] })).toMatchObject({
      type: 'field',
      key: 'k',
    });
    expect(await b.request({ type: 'values', key: 'k2', values: [1, 2, 3, 4] })).toMatchObject({
      type: 'field',
      key: 'k2',
    });
    expect(spawn).toHaveBeenCalledOnce();
    a.dispose();
    expect(worker.terminated).toBe(false);
    b.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('settles requests with what the worker replies, errors included', async () => {
    const [client, worker] = withWorker();
    const done = client.request({ type: 'values', key: 'x', values: [] });
    const { id } = worker.sent[0]!;
    worker.reply({ type: 'error', id, message: 'no layout x' });
    expect(await done).toEqual({ type: 'error', id, message: 'no layout x' });
  });

  it('finishes requests in flight in this thread when the worker fails', async () => {
    const [client, worker] = withWorker();
    const inFlight = client.request(mesh);
    worker.dispatchEvent(new Event('error'));
    expect((await inFlight).type).toBe('mesh');
    expect((await client.request({ type: 'values', key: 'k', values: [1, 2, 3] })).type).toBe(
      'field',
    );
    expect(worker.sent).toHaveLength(1);
  });
});

describe('field client lanes', () => {
  const ask = (key: string): WorkerRequestBody => ({ ...mesh, key }) as WorkerRequestBody;
  const answer = (worker: FakeWorker, i: number): void => {
    const req = worker.sent[i]!;
    worker.reply({ type: 'error', id: req.id, message: `done ${(req as { key: string }).key}` });
  };

  it('keeps one request in flight and one waiting per lane, the latest', async () => {
    const [client, worker] = withWorker();
    const a = client.request(ask('a'), 'heat1');
    const b = client.request(ask('b'), 'heat1');
    const c = client.request(ask('c'), 'heat1');
    const other = client.request(ask('x'), 'heat2');
    // b gave its place to c without reaching the worker; the other lane runs alongside.
    expect(worker.sent.map((r) => (r as { key: string }).key)).toEqual(['a', 'x']);
    expect(await b).toMatchObject({ type: 'error', message: SUPERSEDED });

    answer(worker, 0);
    expect(await a).toMatchObject({ message: 'done a' });
    await Promise.resolve();
    expect(worker.sent.map((r) => (r as { key: string }).key)).toEqual(['a', 'x', 'c']);
    answer(worker, 2);
    expect(await c).toMatchObject({ message: 'done c' });
    answer(worker, 1);
    expect(await other).toMatchObject({ message: 'done x' });

    // The lane is free again: the next request goes straight out.
    await Promise.resolve();
    void client.request(ask('d'), 'heat1');
    expect(worker.sent).toHaveLength(4);
  });

  it('leaves requests without a lane alone', () => {
    const [client, worker] = withWorker();
    void client.request(ask('a'));
    void client.request(ask('b'));
    expect(worker.sent).toHaveLength(2);
  });
});

describe('canvas renderer', () => {
  const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const layout: Layout = {
    key: 'k',
    mesh: {} as NonNullable<Layout['mesh']>,
    grid,
    ids: ['a', 'b', 'c'],
    outline: [],
  };

  it('settles a failed field and does not ask again for the same values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = vi.fn((req: WorkerRequestBody) =>
      Promise.resolve<WorkerResponse>({ type: 'error', id: 1, message: `no ${req.type}` }),
    );
    const r = new CanvasRenderer(canvas, request);
    r.setLayout(layout, false);
    r.setValues([1, 2, 3]);
    expect(r.busy).toBe(true);
    await Promise.resolve();
    expect(r.busy).toBe(false);
    expect(r.readField()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    r.setValues([1, 2, 3]);
    expect(request).toHaveBeenCalledOnce();
    r.setValues([1, 2, 4]);
    expect(request).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
