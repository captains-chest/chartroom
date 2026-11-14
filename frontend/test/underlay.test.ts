import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { loadUnderlay } from '../src/underlay';
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
