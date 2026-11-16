import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { UnderlayStore } from '../src/underlay-store';
import { underlayPath } from '../src/underlay-url';

const PLAN = 'floor_ground';
const U = underlayPath(PLAN);
const V1 = `${U}?v=0123456789ab`;
const V2 = `${U}?v=abcdef012345`;

/**
 * A store over a connection serving each `?v=` as its own image (fetches wait for `release()`
 * when `gated`), drawing into a stand-in for the plan view.
 */
function setup(gated = false) {
  const fetched: string[] = [];
  let release!: () => void;
  const gate = gated ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  const conn: Hass = {
    states: {},
    fetchWithAuth: async (url: string) => {
      fetched.push(url);
      await gate;
      return new Response(new Blob([url], { type: 'image/svg+xml' }));
    },
  };
  const drawn: (string | null)[] = [];
  const store = new UnderlayStore(
    () => conn,
    (url) => void drawn.push(url),
  );
  return { store, fetched, drawn, release: () => release() };
}
/** The image text behind the blob URL drawn last, or null. */
const onScreen = async (drawn: (string | null)[]) => {
  const url = drawn.at(-1);
  return url ? (await fetch(url)).text() : null;
};

describe('UnderlayStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches a plan's image and draws it as a blob URL", async () => {
    const { store, fetched, drawn } = setup();
    await store.show(PLAN, V1);
    expect(fetched).toEqual([V1]);
    expect(drawn.at(-1)).toMatch(/^blob:/);
    expect(await onScreen(drawn)).toBe(V1);
    expect(store.url).toBe(V1);
  });

  it('ignores failures and a missing connection', async () => {
    for (const res of [new Response('', { status: 404 }), new Error('offline')]) {
      const drawn: (string | null)[] = [];
      const store = new UnderlayStore(
        () => ({
          fetchWithAuth: async () => {
            if (res instanceof Error) throw res;
            return res;
          },
        }),
        (url) => void drawn.push(url),
      );
      await store.show(PLAN, V1);
      expect(drawn).toEqual([null]);
    }
    const drawn: (string | null)[] = [];
    await new UnderlayStore(
      () => undefined,
      (url) => void drawn.push(url),
    ).show(PLAN, V1);
    expect(drawn).toEqual([null]);
  });

  it("fetches only the plan's own image, never another URL with the token", async () => {
    const { store, fetched, drawn } = setup();
    for (const url of [
      'https://example.com/x.png',
      '//example.com/x.png',
      '@example.com/x.png',
      '.example.com/x.png',
      '/api/states',
      `${U}/../../states`,
      `${U}?v=1&x=https://example.com`,
      `${U}\n`,
      underlayPath('another_plan'),
      42 as unknown as string,
    ])
      await store.show(PLAN, url);
    await store.show(null, V1);
    expect(fetched).toEqual([]);
    expect(drawn.every((d) => d === null)).toBe(true);
  });

  it('goes back to a replaced image on Undo and forward on Redo without fetching it again', async () => {
    const { store, fetched, drawn } = setup();
    await store.show(PLAN, V1);
    // A new image is uploaded and shown without a fetch.
    store.put(V2, new Blob(['new']));
    expect(await onScreen(drawn)).toBe('new');
    await store.show(PLAN, V2);
    // Undo, Redo, and Undo of the image's removal.
    await store.show(PLAN, V1);
    expect(await onScreen(drawn)).toBe(V1);
    await store.show(PLAN, V2);
    expect(await onScreen(drawn)).toBe('new');
    await store.show(PLAN, null);
    expect(drawn.at(-1)).toBeNull();
    await store.show(PLAN, V2);
    expect(await onScreen(drawn)).toBe('new');
    expect(fetched).toEqual([V1]);
    expect(store.blob(V2)).not.toBeNull();
  });

  it('keeps a bounded number of versions', async () => {
    const { store, fetched } = setup();
    const v = (i: number) => `${U}?v=${String(i).repeat(12)}`;
    for (let i = 1; i <= 4; i++) await store.show(PLAN, v(i));
    expect(store.blob(v(1))).toBeNull();
    expect(store.blob(v(2))).not.toBeNull();
    await store.show(PLAN, v(1));
    expect(fetched).toEqual([v(1), v(2), v(3), v(4), v(1)]);
  });

  it('skips an image it already shows, and fetches one loading only once', async () => {
    const { store, fetched, drawn, release } = setup(true);
    const first = store.show(PLAN, V1);
    // The editor opens while the panel's load is still running: one fetch, drawn once.
    const second = store.show(PLAN, V1);
    release();
    await Promise.all([first, second]);
    expect(fetched).toEqual([V1]);
    expect(drawn.filter((d) => d !== null)).toHaveLength(1);
    await store.show(PLAN, V1);
    expect(drawn.filter((d) => d !== null)).toHaveLength(1);
  });

  it('drops a load overtaken by another image, and revokes every blob URL it replaces', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { store, drawn, release } = setup(true);
    const loading = store.show(PLAN, V1);
    store.put(V2, new Blob(['uploaded']));
    release();
    await loading;
    expect(await onScreen(drawn)).toBe('uploaded');
    const shown = drawn.at(-1)!;
    await store.show('other', null);
    expect(revoke).toHaveBeenCalledWith(shown);
    // V1 is kept even though it was not shown.
    expect(store.blob(V1)).not.toBeNull();
    store.dispose();
    expect(store.blob(V1)).toBeNull();
    expect(drawn.at(-1)).toBeNull();
  });
});
