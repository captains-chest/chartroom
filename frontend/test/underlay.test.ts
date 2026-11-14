import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { loadUnderlay, PanelUnderlay, UnderlayImage } from '../src/underlay';
import { underlayPath } from '../src/underlay-url';

const hass = (res: Response | Error, fetched: string[] = []): Hass => ({
  states: {},
  fetchWithAuth: async (path) => {
    fetched.push(path);
    if (res instanceof Error) throw res;
    return res;
  },
});
const PLAN = 'floor_ground';
const URL_ = `${underlayPath(PLAN)}?v=0123456789ab`;
const image = (): Response => new Response(new Blob(['<svg/>'], { type: 'image/svg+xml' }));

describe('loadUnderlay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the image as a blob URL', async () => {
    const show = vi.fn();
    await loadUnderlay(hass(image()), PLAN, URL_, () => true, show);
    expect(show).toHaveBeenCalledWith(expect.stringMatching(/^blob:/));
  });

  it('revokes the URL of a load that was overtaken', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const show = vi.fn();
    await loadUnderlay(hass(image()), PLAN, URL_, () => false, show);
    expect(show).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(expect.stringMatching(/^blob:/));
  });

  it('ignores failures and a missing connection', async () => {
    const show = vi.fn();
    await loadUnderlay(hass(new Response('', { status: 404 })), PLAN, URL_, () => true, show);
    await loadUnderlay(hass(new Error('offline')), PLAN, URL_, () => true, show);
    await loadUnderlay(undefined, PLAN, URL_, () => true, show);
    expect(show).not.toHaveBeenCalled();
  });

  it("fetches only the plan's own image, never another URL with the token", async () => {
    const fetched: string[] = [];
    const show = vi.fn();
    await loadUnderlay(hass(image(), fetched), PLAN, underlayPath(PLAN), () => true, show);
    expect(fetched).toEqual([underlayPath(PLAN)]);
    for (const url of [
      'https://example.com/x.png',
      '//example.com/x.png',
      '@example.com/x.png',
      '.example.com/x.png',
      '/api/states',
      `${underlayPath(PLAN)}/../../states`,
      `${underlayPath(PLAN)}?v=1&x=https://example.com`,
      `${underlayPath(PLAN)}\n`,
      underlayPath('another_plan'),
      42 as unknown as string,
    ])
      await loadUnderlay(hass(image(), fetched), PLAN, url, () => true, show);
    expect(fetched).toEqual([underlayPath(PLAN)]);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('UnderlayImage', () => {
  const U = underlayPath(PLAN);
  /** A connection serving each `?v=` as its own image, recording the URLs fetched. */
  const versions = () => {
    const fetched: string[] = [];
    const conn: Hass = {
      states: {},
      fetchWithAuth: async (url: string) => {
        fetched.push(url);
        return new Response(new Blob([url], { type: 'image/svg+xml' }));
      },
    };
    return { conn, fetched };
  };
  /** The image text behind each blob URL shown, null for a cleared one. */
  const shown = () => {
    const urls: (string | null)[] = [];
    return { urls, show: (url: string | null) => void urls.push(url) };
  };
  const text = async (blobUrl: string | null) =>
    blobUrl ? (await fetch(blobUrl)).text() : blobUrl;

  it('goes back to the replaced image on Undo and forward on Redo', async () => {
    const { conn, fetched } = versions();
    const { urls, show } = shown();
    const image = new UnderlayImage(() => conn, PLAN, show);
    image.sync(`${U}?v=0123456789ab`);
    await vi.waitFor(() => expect(urls).toHaveLength(2));
    expect(await text(urls[1]!)).toBe(`${U}?v=0123456789ab`);

    // A new image is uploaded and shown without a fetch.
    image.set(`${U}?v=abcdef012345`, new Blob(['new']));
    expect(await text(urls[2]!)).toBe('new');
    image.sync(`${U}?v=abcdef012345`);
    expect(urls).toHaveLength(3);

    // Undo: the plan points at the old version again.
    image.sync(`${U}?v=0123456789ab`);
    await vi.waitFor(() => expect(urls).toHaveLength(5));
    expect(urls[3]).toBeNull();
    expect(await text(urls[4]!)).toBe(`${U}?v=0123456789ab`);
    // Redo.
    image.sync(`${U}?v=abcdef012345`);
    await vi.waitFor(() => expect(urls).toHaveLength(7));
    expect(await text(urls[6]!)).toBe(`${U}?v=abcdef012345`);
    expect(fetched).toEqual([`${U}?v=0123456789ab`, `${U}?v=0123456789ab`, `${U}?v=abcdef012345`]);
  });

  it('keeps the image while the plan has no underlay, and skips one it already shows', async () => {
    const { conn, fetched } = versions();
    const { urls, show } = shown();
    const image = new UnderlayImage(() => conn, PLAN, show, `${U}?v=aaaaaaaaaaaa`);
    image.sync(`${U}?v=aaaaaaaaaaaa`);
    image.sync(null);
    image.sync(`${U}?v=aaaaaaaaaaaa`);
    expect(urls).toEqual([]);
    expect(fetched).toEqual([]);
    expect(image.url).toBe(`${U}?v=aaaaaaaaaaaa`);
  });

  it("never fetches an image that isn't the plan's own", async () => {
    const { conn, fetched } = versions();
    const { show } = shown();
    const image = new UnderlayImage(() => conn, PLAN, show);
    image.sync('.example.com/x.png');
    image.sync(`${underlayPath('another_plan')}?v=0123456789ab`);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toEqual([]);
  });

  it('drops a load still running when the editor closes', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { conn } = versions();
    const { urls, show } = shown();
    const image = new UnderlayImage(() => conn, PLAN, show);
    image.sync(`${U}?v=aaaaaaaaaaaa`);
    image.close();
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(urls).toEqual([null]);
    vi.restoreAllMocks();
  });

  it('drops a load overtaken by another change', async () => {
    const { conn } = versions();
    const { urls, show } = shown();
    const image = new UnderlayImage(() => conn, PLAN, show);
    image.sync(`${U}?v=aaaaaaaaaaaa`);
    image.set(`${U}?v=bbbbbbbbbbbb`, new Blob(['b']));
    await vi.waitFor(() => expect(urls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(urls).toHaveLength(2);
    expect(await text(urls[1]!)).toBe('b');
  });
});

describe('PanelUnderlay', () => {
  const U = `${underlayPath(PLAN)}?v=0123456789ab`;
  /** A stand-in for the plan view: like PlanView, it revokes the blob URL it replaces. */
  const view = () => {
    const revoked = new Set<string>();
    const v = {
      url: null as string | null,
      revoked,
      set(url: string | null) {
        if (url === v.url) return;
        if (v.url) revoked.add(v.url);
        v.url = url;
      },
    };
    return v;
  };
  /** A connection whose fetches wait until `release()`, each its own image. */
  const slow = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const conn: Hass = {
      states: {},
      fetchWithAuth: async (url: string) => {
        await gate;
        return new Response(new Blob([`panel ${url}`], { type: 'image/svg+xml' }));
      },
    };
    return { conn, release };
  };
  const fast: Hass = {
    states: {},
    fetchWithAuth: async (url: string) =>
      new Response(new Blob([`editor ${url}`], { type: 'image/svg+xml' })),
  };
  /** Open the editor the way the panel does: it takes over the view's image. */
  const openEditor = (panel: PanelUnderlay, v: ReturnType<typeof view>) => {
    panel.release();
    let shown: string | null = v.url;
    const image = new UnderlayImage(
      () => fast,
      PLAN,
      (url) => {
        shown = url;
        v.set(url);
      },
      v.url ? U : null,
    );
    image.sync(U);
    return () => shown;
  };

  it("doesn't let a panel load that ends after the editor opened replace the editor's image", async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const v = view();
    const panel = new PanelUnderlay((url) => v.set(url));
    const { conn, release } = slow();
    const loading = panel.load(conn, PLAN, U);

    const editorShown = openEditor(panel, v);
    await vi.waitFor(() => expect(editorShown()).toMatch(/^blob:/));
    const editorUrl = editorShown()!;
    expect(v.url).toBe(editorUrl);

    // The panel's fetch ends only now.
    release();
    await loading;
    expect(v.url).toBe(editorUrl);
    expect(v.revoked.has(editorUrl)).toBe(false);
    expect(await (await fetch(editorUrl)).text()).toBe(`editor ${U}`);
    // The panel's image was never shown, and its blob URL isn't leaked.
    expect(revoke).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('hands an image it already loaded to the editor without a second fetch', async () => {
    const v = view();
    const panel = new PanelUnderlay((url) => v.set(url));
    const { conn, release } = slow();
    const loading = panel.load(conn, PLAN, U);
    release();
    await loading;
    const panelUrl = v.url!;
    expect(await (await fetch(panelUrl)).text()).toBe(`panel ${U}`);

    const editorShown = openEditor(panel, v);
    await new Promise((r) => setTimeout(r, 10));
    expect(editorShown()).toBe(panelUrl);
    expect(v.url).toBe(panelUrl);
    expect(v.revoked.size).toBe(0);
  });

  it('drops an earlier panel load for a later one', async () => {
    const v = view();
    const panel = new PanelUnderlay((url) => v.set(url));
    const first = slow();
    const loading = panel.load(first.conn, PLAN, U);
    await panel.load(fast, PLAN, U);
    const later = v.url;
    first.release();
    await loading;
    expect(v.url).toBe(later);
    expect(await (await fetch(later!)).text()).toBe(`editor ${U}`);
  });
});
