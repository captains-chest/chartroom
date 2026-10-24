import { describe, expect, it } from 'vite-plus/test';
import { MAX_FIELD_SIZE, WORKER_VERSION, handleRequest } from '../src/worker-protocol';

describe('worker protocol', () => {
  it('answers a ping', () => {
    expect(handleRequest({ type: 'ping', id: 7 })).toEqual({
      type: 'pong',
      id: 7,
      version: WORKER_VERSION,
    });
  });

  it('returns an empty field of size squared', () => {
    const res = handleRequest({ type: 'field', id: 1, size: 4 });
    expect(res.type).toBe('field');
    if (res.type === 'field') expect(res.values).toHaveLength(16);
  });

  it('rejects bad sizes', () => {
    for (const size of [0, -1, 1.5, MAX_FIELD_SIZE + 1]) {
      expect(handleRequest({ type: 'field', id: 2, size }).type).toBe('error');
    }
  });
});
