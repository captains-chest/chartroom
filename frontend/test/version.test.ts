import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { HassConnection } from '../src/ha-types';
import { BUILD_VERSION, UpdateNotice, versionMismatch } from '../src/version';
import { installFakeDom } from './fake-dom';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const conn = (reply: () => Promise<unknown>): HassConnection => ({
  sendMessagePromise: <T>() => reply() as Promise<T>,
});

describe('version check', () => {
  it('embeds the package version', () => {
    expect(BUILD_VERSION).toBe(pkg.version);
  });

  it('reports the integration version only when it differs', async () => {
    expect(
      await versionMismatch(
        conn(async () => ({ version: '0.1.0' })),
        '0.1.0',
      ),
    ).toBeNull();
    expect(
      await versionMismatch(
        conn(async () => ({ version: '0.2.0' })),
        '0.1.0',
      ),
    ).toBe('0.2.0');
  });

  it('stays quiet when the integration cannot tell (older version, error)', async () => {
    expect(
      await versionMismatch(
        conn(async () => ({})),
        '0.1.0',
      ),
    ).toBeNull();
    expect(
      await versionMismatch(
        conn(() => Promise.reject(new Error('unknown_command'))),
        '0.1.0',
      ),
    ).toBeNull();
  });
});

describe('update notice', () => {
  installFakeDom();

  /** A connection that counts version checks and keeps its 'ready' listeners. */
  function shared(): { c: HassConnection; ready: Set<() => void>; checks: () => number } {
    const ready = new Set<() => void>();
    const send = vi.fn(async () => ({ version: '0.1.0' }));
    const c: HassConnection = {
      sendMessagePromise: send as HassConnection['sendMessagePromise'],
      addEventListener: (_e, fn) => ready.add(fn),
      removeEventListener: (_e, fn) => ready.delete(fn),
    };
    return { c, ready, checks: () => send.mock.calls.length };
  }

  it('checks again on reconnect until disposed, and watches again after', () => {
    const { c, ready, checks } = shared();
    const notice = new UpdateNotice(() => {});
    notice.watch(c, '0.1.0');
    notice.watch(c, '0.1.0');
    expect(checks()).toBe(1);
    expect(ready.size).toBe(1);
    for (const fn of ready) fn();
    expect(checks()).toBe(2);

    notice.dispose();
    expect(ready.size).toBe(0);

    notice.watch(c, '0.1.0');
    expect(ready.size).toBe(1);
    expect(checks()).toBe(3);
  });

  it('lets go of the old connection for a new one', () => {
    const a = shared();
    const b = shared();
    const notice = new UpdateNotice(() => {});
    notice.watch(a.c, '0.1.0');
    notice.watch(b.c, '0.1.0');
    expect(a.ready.size).toBe(0);
    expect(b.ready.size).toBe(1);
  });
});
