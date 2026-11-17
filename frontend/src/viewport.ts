// Pan and zoom as an SVG viewBox in metres. The viewBox always has the element's aspect ratio,
// so screen and plan coordinates map linearly.
import type { Bounds } from './geometry';
import type { Point } from './plan/types';

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Narrowest and widest visible width in metres. */
export const MIN_WIDTH = 0.5;
export const MAX_WIDTH = 500;

/** A box in pixels within the element. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A view that shows `b` with `margin` metres around it in a `width`×`height` element. `cover`: a box
 * in one corner (the legend) the plan stays clear of, beside it or above/below it, whichever shows
 * the plan larger.
 */
export function fitView(
  b: Bounds | null,
  width: number,
  height: number,
  margin = 0.5,
  cover?: Box | null,
): View {
  const box = b ?? { minX: 0, minY: 0, maxX: 10, maxY: 8 };
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  // The plan centred in the element less `l`, `t`, `r`, `btm` pixels at its edges.
  const at = (l: number, t: number, r: number, btm: number): View & { k: number } => {
    const aw = Math.max(1, width - l - r);
    const ah = Math.max(1, height - t - btm);
    const k = Math.max(
      (box.maxX - box.minX + 2 * margin) / aw,
      (box.maxY - box.minY + 2 * margin) / ah,
    );
    return { x: cx - (l + aw / 2) * k, y: cy - (t + ah / 2) * k, w: width * k, h: height * k, k };
  };
  let v = at(0, 0, 0, 0);
  if (cover) {
    const side =
      cover.left + cover.right > width ? at(0, 0, width - cover.left, 0) : at(cover.right, 0, 0, 0);
    const end =
      cover.top + cover.bottom > height
        ? at(0, 0, 0, height - cover.top)
        : at(0, cover.bottom, 0, 0);
    v = side.k < end.k ? side : end;
  }
  return { x: v.x, y: v.y, w: v.w, h: v.h };
}

/** Same centre and width, new aspect (the element was resized). */
export function withAspect(v: View, aspect: number): View {
  const h = v.w / aspect;
  return { x: v.x, y: v.y + (v.h - h) / 2, w: v.w, h };
}

/** Zoom by `factor` (>1 zooms in) keeping plan point `p` where it is on screen. */
export function zoomAt(v: View, p: Point, factor: number): View {
  const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v.w / factor));
  const k = w / v.w;
  return { x: p[0] - (p[0] - v.x) * k, y: p[1] - (p[1] - v.y) * k, w, h: v.h * k };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

/** Plan point under a screen position, given the element's size in pixels. */
export function toPlan(v: View, px: number, py: number, width: number, height: number): Point {
  return [v.x + (px / width) * v.w, v.y + (py / height) * v.h];
}

/** Metres per screen pixel. */
export const metresPerPixel = (v: View, width: number): number => v.w / width;

export const viewBoxOf = (v: View): string =>
  [v.x, v.y, v.w, v.h].map((n) => Math.round(n * 1000) / 1000).join(' ');
