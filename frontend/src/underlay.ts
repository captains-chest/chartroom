// Underlay images: shrink in the browser, upload to the integration, and load back as blob URLs
// (the image view needs the user's token, which an <image href> cannot send).
import { planBounds } from './geometry';
import type { Hass } from './ha-types';
import type { Plan, Underlay } from './plan/models';

/** Longest side kept for raster images. */
export const MAX_SIDE = 2048;
export const MAX_BYTES = 10 * 1024 * 1024;

export const underlayPath = (planId: string): string =>
  `/api/chartroom/underlay/${encodeURIComponent(planId)}`;

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
): Promise<{ underlay: Underlay; blobUrl: string }> {
  if (!hass?.fetchWithAuth) throw new Error('not connected');
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type))
    throw new Error('use a PNG, JPEG, WebP or SVG');
  const { blob, width, height } = await prepare(file);
  if (blob.size > MAX_BYTES) throw new Error('image is larger than 10 MB');
  const res = await hass.fetchWithAuth(underlayPath(planId), {
    method: 'POST',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const { url } = (await res.json()) as { url: string };
  return { underlay: placeUnderlay(plan, url, width, height), blobUrl: URL.createObjectURL(blob) };
}

/**
 * Fetch a plan's image and `show` it as a blob URL, unless `current()` says a newer load or image
 * took over meanwhile (the URL is revoked then). Failures are ignored: the plan works without it.
 */
export async function loadUnderlay(
  hass: Hass | undefined,
  url: string,
  current: () => boolean,
  show: (blobUrl: string) => void,
): Promise<void> {
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
