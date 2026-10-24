// Test-only heatmap hooks, injected into the page (page.addInitScript) instead of shipping with
// the integration: read the field back, and draw the same field with WebGL2 and with the
// Canvas2D fallback to compare them. They work on HeatLayer.debug(); everything they need is
// inside installHeatDebug, which Playwright serialises into the page.
import type { Page } from '@playwright/test';
import type { GlRenderer } from '../frontend/src/heat-gl';
import type {
  CanvasRenderer,
  DebugContext,
  HeatLayer,
  RendererKind,
} from '../frontend/src/heat-layer';

export interface Compare {
  renderer: RendererKind;
  cells: number;
  fieldMaxDiff: number;
  confMaxDiff: number;
  fadeMaxDiff: number;
  fieldP999Diff: number;
  fieldOver: number;
  worst: { cell: [number, number]; gl: number; cpu: number }[];
  range: number;
  pixels: number;
  pixelMaxDiff: number;
  pixelMeanDiff: number;
}

export interface HeatDebug {
  /** The current field (value, confidence, fade per cell) from the active renderer. */
  readField(heat: unknown): Promise<{ renderer: RendererKind; field: number[] }>;
  /** Draw the settled field both ways (same values, same view) and say how far apart they are. */
  compareRenderers(heat: unknown): Promise<Compare | null>;
}

declare global {
  interface Window {
    chartroomDebug: HeatDebug;
  }
}

export function installHeatDebug(): void {
  /** The GL field target read back: value, confidence, fade per cell. */
  const glField = (r: GlRenderer): Float32Array | null => {
    const { gl } = r;
    const t = r.target;
    if (!t.grid) return null;
    const { nx, ny } = t.grid;
    const rgba = new Float32Array(nx * ny * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.FLOAT, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Float32Array(nx * ny * 3);
    for (let c = 0; c < nx * ny; c++) out.set(rgba.subarray(c * 4, c * 4 + 3), c * 3);
    return out;
  };
  /** The GL canvas as straight (not premultiplied) RGBA, top row first. */
  const glPixels = (r: GlRenderer): Uint8ClampedArray => {
    const { gl } = r;
    const w = gl.canvas.width;
    const h = gl.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4;
        const d = (y * w + x) * 4;
        const a = px[s + 3]!;
        for (let c = 0; c < 3; c++) out[d + c] = a ? Math.round((px[s + c]! * 255) / a) : 0;
        out[d + 3] = a;
      }
    return out;
  };
  const canvasPixels = (r: CanvasRenderer): Uint8ClampedArray =>
    r.ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
  const settled = async (h: unknown): Promise<DebugContext> => {
    const heat = h as HeatLayer;
    await heat.idle();
    return heat.debug();
  };

  window.chartroomDebug = {
    async readField(heat) {
      const c = await settled(heat);
      const f = c.gl ? glField(c.gl) : (c.c2d?.field ?? null);
      return { renderer: c.renderer, field: f ? Array.from(f) : [] };
    },

    async compareRenderers(heat) {
      const c = await settled(heat);
      const { layout: L, gl, values, domain, view, opacity } = c;
      if (!L || !gl) return null;
      c.upload();
      gl.draw(view, domain, opacity, 1);
      const glF = glField(gl)!;
      const glPx = glPixels(gl);
      const { signal } = L;
      const res = await c.request(
        signal
          ? {
              type: 'signal',
              key: L.key,
              grid: L.grid,
              outline: c.outline,
              walls: signal.walls,
              aps: signal.aps,
            }
          : { type: 'values', key: L.key, values },
      );
      if (res.type !== 'field') return null;
      const canvas = document.createElement('canvas');
      canvas.width = c.canvas.width;
      canvas.height = c.canvas.height;
      const c2d = c.canvasRenderer(canvas);
      c2d.setField(res.field, res.grid);
      c2d.draw(view, domain, opacity, 1, c.lut);
      const cpuPx = canvasPixels(c2d);
      // Per channel: value, confidence, fade.
      const diff = [0, 0, 0];
      const tol = 1e-3 * (domain[1] - domain[0]);
      const valueDiffs = new Float32Array(glF.length / 3);
      const worst: Compare['worst'] = [];
      for (let i = 0; i < glF.length; i++) {
        const d = Math.abs(glF[i]! - res.field[i]!);
        if (i % 3 === 0) {
          valueDiffs[i / 3] = d;
          if (d > tol && worst.length < 8)
            worst.push({
              cell: [(i / 3) % L.grid.nx, Math.floor(i / 3 / L.grid.nx)],
              gl: glF[i]!,
              cpu: res.field[i]!,
            });
        }
        diff[i % 3] = Math.max(diff[i % 3]!, d);
      }
      valueDiffs.sort();
      const fieldP999Diff = valueDiffs[Math.floor((valueDiffs.length - 1) * 0.999)] ?? 0;
      const fieldOver = valueDiffs.filter((d) => d > tol).length;
      // Compare colour where both are clearly visible; alpha everywhere.
      let pixels = 0;
      let max = 0;
      let sum = 0;
      for (let i = 0; i < glPx.length; i += 4 * 7) {
        let d = Math.abs(glPx[i + 3]! - cpuPx[i + 3]!);
        if (glPx[i + 3]! > 64 && cpuPx[i + 3]! > 64)
          for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(glPx[i + k]! - cpuPx[i + k]!));
        pixels++;
        max = Math.max(max, d);
        sum += d;
      }
      // Put the visible canvas back.
      gl.draw(view, domain, opacity, 1);
      return {
        renderer: c.renderer,
        cells: L.grid.nx * L.grid.ny,
        fieldMaxDiff: diff[0]!,
        confMaxDiff: diff[1]!,
        fadeMaxDiff: diff[2]!,
        fieldP999Diff,
        fieldOver,
        worst,
        range: domain[1] - domain[0],
        pixels,
        pixelMaxDiff: max,
        pixelMeanDiff: sum / Math.max(1, pixels),
      };
    },
  };
}

/** Make the hooks available on every page load of this test. */
export const useHeatDebug = async (page: Page): Promise<void> => {
  await page.addInitScript(installHeatDebug);
};
