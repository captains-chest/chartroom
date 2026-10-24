import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { loadUnderlay } from '../src/underlay';

const hass = (res: Response | Error): Hass => ({
  states: {},
  fetchWithAuth: async () => {
    if (res instanceof Error) throw res;
    return res;
  },
});
const image = (): Response => new Response(new Blob(['<svg/>'], { type: 'image/svg+xml' }));

describe('loadUnderlay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the image as a blob URL', async () => {
    const show = vi.fn();
    await loadUnderlay(hass(image()), '/u', () => true, show);
    expect(show).toHaveBeenCalledWith(expect.stringMatching(/^blob:/));
  });

  it('revokes the URL of a load that was overtaken', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const show = vi.fn();
    await loadUnderlay(hass(image()), '/u', () => false, show);
    expect(show).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(expect.stringMatching(/^blob:/));
  });

  it('ignores failures and a missing connection', async () => {
    const show = vi.fn();
    await loadUnderlay(hass(new Response('', { status: 404 })), '/u', () => true, show);
    await loadUnderlay(hass(new Error('offline')), '/u', () => true, show);
    await loadUnderlay(undefined, '/u', () => true, show);
    expect(show).not.toHaveBeenCalled();
  });
});
