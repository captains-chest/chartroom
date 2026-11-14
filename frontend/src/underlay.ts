// Underlay images: shrink in the browser, upload to the integration, and load back as blob URLs
// (the image view needs the user's token, which an <image href> cannot send).
import { planBounds } from './geometry';
import type { Hass } from './ha-types';
import type { Plan, Underlay } from './plan/models';
import { underlayPath, underlayPlanId } from './underlay-url';

/** Longest side kept for raster images. */
export const MAX_SIDE = 2048;
export const MAX_BYTES = 10 * 1024 * 1024;

/** The image types the integration stores. */
export const UNDERLAY_TYPES = /^image\/(png|jpeg|webp|svg\+xml)$/;

/**
 * Where a new image goes: over the existing walls when there are some (same width), otherwise
 * 10 m wide at the origin. Calibration fixes the scale afterwards.
 */
export function placeUnderlay(plan: Plan, url: string, width: number, height: number): Underlay {
  const b = planBounds({ ...plan, underlay: null });
  const metres = b ? Math.max(1, b.maxX - b.minX) : 10;
  const scale = metres / width;
  return {
    url,
    width_px: width,
    height_px: height,
    scale: Math.round(scale * 1e7) / 1e7,
    origin: b ? [b.minX, b.minY] : [0, 0],
    opacity: plan.underlay?.opacity ?? 0.5,
  };
}

/** Scale a size down so the longest side is at most `max`. */
export function fitSize(width: number, height: number, max = MAX_SIDE): [number, number] {
  const k = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}

async function prepare(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  if (file.type === 'image/svg+xml') {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { blob: file, width: img.naturalWidth || 1000, height: img.naturalHeight || 1000 };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bitmap = await createImageBitmap(file);
  const [width, height] = fitSize(bitmap.width, bitmap.height);
  if (width === bitmap.width && file.size <= MAX_BYTES && file.type !== 'image/webp') {
    bitmap.close();
    return { blob: file, width, height };
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return { blob: await canvas.convertToBlob({ type, quality: 0.9 }), width, height };
}

export async function importUnderlay(
  hass: Hass | undefined,
  planId: string,
  file: File,
  plan: Plan,
): Promise<{ underlay: Underlay; blob: Blob }> {
  if (!hass?.fetchWithAuth) throw new Error('not connected');
  if (!UNDERLAY_TYPES.test(file.type)) throw new Error('use a PNG, JPEG, WebP or SVG');
  const { blob, width, height } = await prepare(file);
  const url = await uploadUnderlay(hass, planId, blob);
  return { underlay: placeUnderlay(plan, url, width, height), blob };
}

/**
 * Store `blob` as a new version of the plan's image; the URL the plan points at it with. The
 * previous versions stay until the editor closes, so Undo can go back to them.
 */
export async function uploadUnderlay(
  hass: Hass | undefined,
  planId: string,
  blob: Blob,
): Promise<string> {
  if (!hass?.fetchWithAuth) throw new Error('not connected');
  if (blob.size > MAX_BYTES) throw new Error('image is larger than 10 MB');
  const res = await hass.fetchWithAuth(underlayPath(planId), {
    method: 'POST',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return ((await res.json()) as { url: string }).url;
}

/**
 * Fetch the plan `planId`'s image and `show` it as a blob URL, unless `current()` says a newer load
 * or image took over meanwhile (the URL is revoked then). Failures are ignored: the plan works
 * without it. A URL that is not the plan's own image is never fetched: the fetch carries the
 * user's token, and a plan stored before the integration checked it may point anywhere.
 */
export async function loadUnderlay(
  hass: Hass | undefined,
  planId: string,
  url: string,
  current: () => boolean,
  show: (blobUrl: string) => void,
): Promise<void> {
  if (underlayPlanId(url) !== planId) return;
  try {
    const res = await hass?.fetchWithAuth?.(url);
    if (!res?.ok) return;
    const blobUrl = URL.createObjectURL(await res.blob());
    if (current()) show(blobUrl);
    else URL.revokeObjectURL(blobUrl);
  } catch {
    // Offline or gone: the plan shows without its drawing.
  }
}

/**
 * The panel's own underlay loads into the read-only view. Once the editor opens it owns the view's
 * image, so `release()` drops a panel load still in flight (its blob URL is revoked, not shown).
 */
export class PanelUnderlay {
  #load = 0;
  readonly #show: (blobUrl: string | null) => void;

  constructor(show: (blobUrl: string | null) => void) {
    this.#show = show;
  }

  /** Show plan `planId`'s image at `url` (none for null), dropping any earlier load. */
  async load(hass: Hass | undefined, planId: string | null, url: string | null): Promise<void> {
    const load = ++this.#load;
    this.#show(null);
    if (url && planId) await loadUnderlay(hass, planId, url, () => load === this.#load, this.#show);
  }

  /** Hand the view's image over to the editor: a panel load still in flight is dropped. */
  release(): void {
    this.#load++;
  }
}

/**
 * The editor's underlay image, kept in step with the plan's underlay URL: Undo and Redo switch
 * between stored versions of the image, so a URL change means fetching that version.
 */
export class UnderlayImage {
  /** The image URL on screen or loading, or null. */
  #url: string | null;
  #closed = false;
  readonly #hass: () => Hass | undefined;
  readonly #planId: string;
  readonly #show: (blobUrl: string | null) => void;

  /**
   * `show` gets a blob URL for the image, or null while another one loads. `shown` is the URL
   * of an image already on screen. Only plan `planId`'s own image is ever fetched.
   */
  constructor(
    hass: () => Hass | undefined,
    planId: string,
    show: (blobUrl: string | null) => void,
    shown: string | null = null,
  ) {
    this.#hass = hass;
    this.#planId = planId;
    this.#show = show;
    this.#url = shown;
  }

  /** The image URL on screen or loading. */
  get url(): string | null {
    return this.#url;
  }

  /** Show the image just stored at `url`, without fetching it back. */
  set(url: string, blob: Blob): void {
    this.#url = url;
    this.#show(URL.createObjectURL(blob));
  }

  /**
   * Show the image at the plan's underlay `url`, fetching it unless it is already shown. No
   * underlay (null) keeps the last image, so undoing its removal needs no fetch.
   */
  sync(url: string | null): void {
    if (url === null || url === this.#url) return;
    this.#url = url;
    this.#show(null);
    void loadUnderlay(
      this.#hass(),
      this.#planId,
      url,
      () => !this.#closed && this.#url === url,
      this.#show,
    );
  }

  /** The editor closed: a load still running is dropped, and the panel owns the image again. */
  close(): void {
    this.#closed = true;
  }
}
