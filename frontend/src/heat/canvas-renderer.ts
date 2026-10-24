// The Canvas2D fallback: the field worker computes the field grid (fillField in field-plan.ts,
// signalField in signal.ts), coloured here per cell through the ramp into an image of one pixel
// per cell and scaled up with smoothing.
import type { FieldGrid } from '../field';
import type { View } from '../viewport';
import type { WorkerRequestBody } from '../worker-protocol';
import { NO_DATA_ALPHA, NO_DATA_GREY } from './constants';
import type { FieldRenderer, Layout } from './models';
import type { FieldRequest } from './types';

type FieldWork = Extract<WorkerRequestBody, { type: 'signal' | 'values' }>;

interface CanvasField {
  field: Float32Array;
  grid: FieldGrid;
  img: HTMLCanvasElement;
}

/** Colours a field grid through the ramp into an image of one pixel per cell (TS reference of
 * the GL colour pass, `colour` in gl-renderer.ts). */
function colourise(
  field: Float32Array,
  grid: FieldGrid,
  domain: readonly [number, number],
  opacity: number,
  lut: Uint8Array,
  canvas: HTMLCanvasElement,
): void {
  if (canvas.width !== grid.nx || canvas.height !== grid.ny) {
    canvas.width = grid.nx;
    canvas.height = grid.ny;
  }
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(grid.nx, grid.ny);
  const span = Math.max(1e-6, domain[1] - domain[0]);
  const grey = Math.round(255 * NO_DATA_GREY);
  for (let c = 0; c < grid.nx * grid.ny; c++) {
    const t = Math.min(1, Math.max(0, (field[c * 3]! - domain[0]) / span));
    const k = Math.round(t * 255) * 4;
    const d = c * 4;
    // Negative confidence: no data, drawn grey (as the GL colour pass does).
    const none = field[c * 3 + 1]! < 0;
    img.data[d] = none ? grey : lut[k]!;
    img.data[d + 1] = none ? grey : lut[k + 1]!;
    img.data[d + 2] = none ? grey : lut[k + 2]!;
    img.data[d + 3] = Math.round(
      255 * opacity * (none ? NO_DATA_ALPHA : field[c * 3 + 1]!) * field[c * 3 + 2]!,
    );
  }
  ctx.putImageData(img, 0, 0);
}

export class CanvasRenderer implements FieldRenderer {
  readonly kind = 'canvas';
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #request: FieldRequest;
  #lut: Uint8Array = new Uint8Array(0);
  #layout: Layout | null = null;
  #cur: CanvasField | null = null;
  #prev: CanvasField | null = null;
  #keepNext = false;
  /** The values the current field was computed from. */
  #fieldFor = '';
  #inflight = 0;

  /** `request` reaches the field worker, which computes every field this renderer draws. */
  constructor(canvas: HTMLCanvasElement, request: FieldRequest) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no Canvas2D');
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#request = request;
  }

  get busy(): boolean {
    return this.#inflight > 0;
  }

  setRamp(lut: Uint8Array): void {
    this.#lut = lut;
  }

  setLayout(layout: Layout, fade: boolean): void {
    this.#layout = layout;
    this.#fieldFor = '';
    this.#keepNext = fade;
    if (!fade) this.#prev = null;
    const { key, grid, outline, signal } = layout;
    if (signal)
      this.#compute({ type: 'signal', key, grid, outline, walls: signal.walls, aps: signal.aps });
  }

  setValues(values: number[]): void {
    const L = this.#layout;
    const want = values.join(',');
    if (!L?.mesh || this.#inflight || want === this.#fieldFor) return;
    this.#compute({ type: 'values', key: L.key, values }, want);
  }

  /**
   * Ask the worker for a field; a reply for a layout since replaced is dropped. A failed field
   * blanks the layer and is not retried until the values or the layout change.
   */
  #compute(req: FieldWork, values = ''): void {
    this.#inflight++;
    void this.#request(req).then((res) => {
      this.#inflight--;
      if (req.key !== this.#layout?.key) return;
      if (res.type === 'field') this.#setField(res.field, res.grid);
      else {
        console.warn('Chartroom heatmap:', res);
        this.#cur = this.#prev = null;
      }
      this.#fieldFor = values;
    });
  }

  #setField(field: Float32Array, grid: FieldGrid): void {
    if (this.#keepNext && this.#cur) {
      this.#prev = this.#cur;
      this.#cur = null;
    }
    this.#keepNext = false;
    this.#cur = { field, grid, img: this.#cur?.img ?? document.createElement('canvas') };
  }

  dropPrevious(): void {
    this.#prev = null;
  }

  draw(view: View, domain: readonly [number, number], opacity: number, mix: number): void {
    const ctx = this.#ctx;
    const canvas = this.#canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const layer = (l: CanvasField, alpha: number): void => {
      colourise(l.field, l.grid, domain, opacity, this.#lut, l.img);
      const kx = canvas.width / view.w;
      const ky = canvas.height / view.h;
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(
        l.img,
        (l.grid.x0 - view.x) * kx,
        (l.grid.y0 - view.y) * ky,
        l.grid.nx * l.grid.cell * kx,
        l.grid.ny * l.grid.cell * ky,
      );
    };
    if (this.#prev && mix < 1) layer(this.#prev, 1 - mix);
    if (this.#cur) layer(this.#cur, this.#prev && mix < 1 ? mix : 1);
    ctx.globalAlpha = 1;
  }

  readField(): Float32Array | null {
    return this.#cur?.field ?? null;
  }

  dispose(): void {
    // Replies still on their way are dropped.
    this.#layout = null;
  }
}
