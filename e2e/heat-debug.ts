// Test-only heatmap hooks, injected into the page (page.addInitScript) instead of shipping with
// the integration: read the field back, and draw the same field with WebGL2 and with the
// Canvas2D fallback to compare them. They use HeatLayer's public surface (idle, renderer,
// setRenderer) and its one probe, readField; everything they need is inside installHeatDebug,
// which Playwright serialises into the page.
import type { Page } from '@playwright/test';
import type { HeatLayer } from '../frontend/src/heat-layer';
import type { RendererKind } from '../frontend/src/heat/types';

export interface Compare {
  renderer: RendererKind;
  cells: number;
  fieldMaxDiff: number;
  confMaxDiff: number;
  fadeMaxDiff: number;
  fieldP999Diff: number;
  fieldOver: number;
  worst: { cell: number; gl: number; cpu: number }[];
  range: number;
  pixels: number;
  pixelMaxDiff: number;
  pixelMeanDiff: number;
}

export interface HeatDebug {
  /** The current field (value, confidence, fade per cell) from the active renderer. */
  readField(heat: unknown): Promise<{ renderer: RendererKind; field: number[] }>;
  /**
   * Draw the settled field with WebGL2, switch the layer to Canvas2D and back, and say how far
   * apart the two fields and pictures are (same readings, same view).
   */
  compareRenderers(heat: unknown): Promise<Compare | null>;
}

declare global {
  interface Window {
    chartroomDebug: HeatDebug;
  }
}

export function installHeatDebug(): void {
  // Keep WebGL drawing buffers after compositing, so a settled heatmap can be read back.
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (this: HTMLCanvasElement, type: string, attrs?: object) => unknown;
  };
  const getContext = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, type, attrs) {
    return getContext.call(
      this,
      type,
      type === 'webgl2' ? { ...attrs, preserveDrawingBuffer: true } : attrs,
    );
  };

  /** The heat canvas as straight (not premultiplied) RGBA, top row first. */
  const pixels = (heat: HeatLayer): Uint8ClampedArray => {
    const canvas = heat.box.querySelector('canvas')!;
    const w = canvas.width;
    const h = canvas.height;
    if (heat.renderer === 'canvas') return canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
    const gl = canvas.getContext('webgl2')!;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
  type Capture = { field: Float32Array | null; px: Uint8ClampedArray };
  /** The settled field and picture of the active renderer. */
  const capture = async (heat: HeatLayer): Promise<Capture> => {
    await heat.idle();
    return { field: heat.readField(), px: pixels(heat) };
  };
  const readings = (heat: HeatLayer): string => JSON.stringify(heat.data?.readings);

  window.chartroomDebug = {
    async readField(h) {
      const heat = h as HeatLayer;
      await heat.idle();
      const f = heat.readField();
      return { renderer: heat.renderer, field: f ? Array.from(f) : [] };
    },

    async compareRenderers(h) {
      const heat = h as HeatLayer;
      await heat.idle();
      if (heat.renderer !== 'webgl2') return null;
      // Both renderers must draw the same readings: a pair taken across a new reading is retaken.
      let gl: Capture | null = null;
      let cpu: Capture | null = null;
      for (let i = 0; i < 3; i++) {
        const before = readings(heat);
        gl = await capture(heat);
        heat.setRenderer('canvas');
        cpu = await capture(heat);
        heat.setRenderer('webgl2');
        await heat.idle();
        if (readings(heat) === before) break;
      }
      const glF = gl?.field;
      const cpuF = cpu?.field;
      if (!gl || !cpu || !glF || !cpuF || glF.length !== cpuF.length) return null;
      // The range the ramp spans, from the legend's scale.
      const scale = [...heat.legend.querySelectorAll('.heat-scale span')].map((s) =>
        Number(s.textContent),
      );
      const range = scale[scale.length - 1]! - scale[0]!;
      // Per channel: value, confidence, fade.
      const diff = [0, 0, 0];
      const tol = 1e-3 * range;
      const valueDiffs = new Float32Array(glF.length / 3);
      const worst: Compare['worst'] = [];
      for (let i = 0; i < glF.length; i++) {
        const d = Math.abs(glF[i]! - cpuF[i]!);
        if (i % 3 === 0) {
          valueDiffs[i / 3] = d;
          if (d > tol && worst.length < 8) worst.push({ cell: i / 3, gl: glF[i]!, cpu: cpuF[i]! });
        }
        diff[i % 3] = Math.max(diff[i % 3]!, d);
      }
      valueDiffs.sort();
      const fieldP999Diff = valueDiffs[Math.floor((valueDiffs.length - 1) * 0.999)] ?? 0;
      const fieldOver = valueDiffs.filter((d) => d > tol).length;
      // Compare colour where both are clearly visible; alpha everywhere.
      const glPx = gl.px;
      const cpuPx = cpu.px;
      let count = 0;
      let max = 0;
      let sum = 0;
      for (let i = 0; i < glPx.length; i += 4 * 7) {
        let d = Math.abs(glPx[i + 3]! - cpuPx[i + 3]!);
        if (glPx[i + 3]! > 64 && cpuPx[i + 3]! > 64)
          for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(glPx[i + k]! - cpuPx[i + k]!));
        count++;
        max = Math.max(max, d);
        sum += d;
      }
      return {
        renderer: heat.renderer,
        cells: glF.length / 3,
        fieldMaxDiff: diff[0]!,
        confMaxDiff: diff[1]!,
        fadeMaxDiff: diff[2]!,
        fieldP999Diff,
        fieldOver,
        worst,
        range,
        pixels: count,
        pixelMaxDiff: max,
        pixelMeanDiff: sum / Math.max(1, count),
      };
    },
  };
}

/** Make the hooks available on every page load of this test. */
export const useHeatDebug = async (page: Page): Promise<void> => {
  await page.addInitScript(installHeatDebug);
};
