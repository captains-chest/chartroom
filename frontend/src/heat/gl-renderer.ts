// The WebGL2 heatmap renderer, hand-written (docs/render-design.md, "Pipeline"):
// pass 1, the field into an RGBA32F target (value, confidence, fade per cell): for temperature and
//   humidity the per-cell node weights the worker worked out once per layout (field-plan.ts: which
//   sensors each cell sees past the walls) applied to the current node values; for the signal
//   layer, one ray-tracing pass over the grid;
// pass 2, the colour pass: each of the four nearest cells through the 256x1 ramp (or grey where
//   there is no data), confidence and fade as alpha, mixed bilinearly so colours stop at a wall
//   instead of blending values across it; the view transform; a cross-fade with the previous field.
// The TypeScript functions named next to each GLSL function are the reference: the Canvas2D
// fallback runs them, and the e2e agreement tests (e2e/heat-debug.ts) check the two match.
import { FADE_DISTANCE, OUTSIDE_ALPHA, nodeValues, type FieldGrid, type FieldMesh } from '../field';
import type { FieldPlan } from '../field-plan';
import type { Point } from '../plan';
import {
  MAX_SIGNAL_SEGMENTS,
  MAX_SIGNAL_SOURCES,
  SEG,
  SIGNAL_FLOOR,
  SIGNAL_N,
  SRC,
  type SignalInput,
} from '../signal';
import type { View } from '../viewport';
import { NO_DATA_ALPHA, NO_DATA_GREY } from './constants';
import type { FieldRenderer, Layout } from './models';

const FIELD_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Shared by the field passes: the outside fade from the outline (fadeAt in field.ts).
const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uOutline; // x, y per outline vertex
uniform int uOutlineCount;
uniform vec3 uGrid;         // x0, y0, cell
uniform vec2 uFade;         // outside alpha, distance
out vec4 outField;
// TS reference: fadeAt in field.ts.
float fadeAt(vec2 p) {
  if (uOutlineCount < 3) return 1.0;
  bool inside = false;
  float od = 1e30;
  vec2 prev = texelFetch(uOutline, ivec2(uOutlineCount - 1, 0), 0).xy;
  for (int i = 0; i < 16384; i++) {
    if (i >= uOutlineCount) break;
    vec2 cur = texelFetch(uOutline, ivec2(i, 0), 0).xy;
    if ((cur.y > p.y) != (prev.y > p.y) &&
        p.x < (prev.x - cur.x) * (p.y - cur.y) / (prev.y - cur.y) + cur.x) inside = !inside;
    vec2 e = cur - prev;
    float l2 = dot(e, e);
    float t = l2 > 0.0 ? clamp(dot(p - prev, e) / l2, 0.0, 1.0) : 0.0;
    vec2 d = p - prev - t * e;
    od = min(od, dot(d, d));
    prev = cur;
  }
  return inside ? 1.0 : uFade.x * (1.0 - smoothstep(0.0, uFade.y, sqrt(od)));
}
`;

// Temperature and humidity: up to three node values per cell, weighted (fillField in field-plan.ts).
const WEIGHTS_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uIdx;  // node indices, confidence (-1: no data)
uniform sampler2D uW;    // weights, fade
uniform sampler2D uVals; // node values
out vec4 outField;
float val(float i) { return texelFetch(uVals, ivec2(int(i), 0), 0).x; }
// TS reference: fillField in field-plan.ts.
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 i = texelFetch(uIdx, c, 0);
  vec4 w = texelFetch(uW, c, 0);
  outField = vec4(w.x * val(i.x) + w.y * val(i.y) + w.z * val(i.z), i.w, w.w, 1.0);
}`;

// The signal pass (signalAt in signal.ts, line for line): per source, log-distance loss from its
// level at 1 m, minus each wall segment the ray from it crosses; the strongest source wins.
const SIGNAL_FS = `${HEAD}
uniform sampler2D uWalls;   // row 0: ax, ay, bx, by; row 1: loss in dB
uniform int uWallCount;
uniform int uApCount;
uniform vec4 uAps[${MAX_SIGNAL_SOURCES}]; // x, y, level at 1 m
uniform vec2 uModel;        // path-loss exponent, floor
// TS reference: signalAt in signal.ts (signalField per cell).
void main() {
  vec2 p = uGrid.xy + gl_FragCoord.xy * uGrid.z;
  float best = uModel.y;
  for (int k = 0; k < ${MAX_SIGNAL_SOURCES}; k++) {
    if (k >= uApCount) break;
    vec2 a = uAps[k].xy;
    vec2 r = p - a;
    float rx = uAps[k].z - 10.0 * uModel.x * log2(max(length(r), 1.0)) * 0.30102999566;
    if (rx <= best) continue;
    for (int w = 0; w < ${MAX_SIGNAL_SEGMENTS}; w++) {
      if (w >= uWallCount) break;
      vec4 s = texelFetch(uWalls, ivec2(w, 0), 0);
      vec2 q = s.xy - a;
      vec2 e = s.zw - s.xy;
      float den = r.x * e.y - r.y * e.x;
      if (abs(den) < 1e-12) continue;
      float t = (q.x * e.y - q.y * e.x) / den;
      float u = (q.x * r.y - q.y * r.x) / den;
      if (t > 0.0 && t <= 1.0 && u >= 0.0 && u <= 1.0) {
        rx -= texelFetch(uWalls, ivec2(w, 1), 0).x;
        if (rx <= best) break;
      }
    }
    best = max(best, rx);
  }
  outField = vec4(best, 1.0, fadeAt(p), 1.0);
}`;

const COLOUR_VS = `#version 300 es
in vec2 aPos;       // unit quad
uniform vec3 uGrid;
uniform vec2 uSize;
uniform vec4 uView; // x, y, w, h of the view in metres
out vec2 vPlan;
void main() {
  vec2 p = uGrid.xy + aPos * uSize * uGrid.z;
  vPlan = p;
  vec2 c = (p - uView.xy) / uView.zw;
  gl_Position = vec4(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
}`;

const COLOUR_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uField;
uniform sampler2D uPrev;
uniform sampler2D uRamp;
uniform vec3 uGrid;
uniform vec2 uSize;
uniform vec3 uPrevGrid;
uniform vec2 uPrevSize;
uniform vec2 uDomain;
uniform float uOpacity;
uniform float uMix;
uniform vec2 uNoData;   // grey level, alpha
in vec2 vPlan;
out vec4 outColour;
// One cell, premultiplied. TS reference: colourise in canvas-renderer.ts, per cell.
vec4 colour(vec4 s) {
  if (s.y < 0.0) { float g = uOpacity * uNoData.y * s.z; return vec4(vec3(uNoData.x) * g, g); }
  float t = clamp((s.x - uDomain.x) / max(1e-6, uDomain.y - uDomain.x), 0.0, 1.0);
  vec3 rgb = texture(uRamp, vec2((t * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  float a = uOpacity * s.y * s.z;
  return vec4(rgb * a, a);
}
// Bilinear over coloured cells. Reference: CanvasRenderer.draw, Canvas2D smoothing the image.
vec4 sampleColour(sampler2D f, vec2 cellPos, vec2 size) {
  vec2 q = cellPos - 0.5;
  vec2 fl = floor(q);
  vec2 fr = q - fl;
  ivec2 i0 = ivec2(fl);
  ivec2 mx = ivec2(size) - 1;
  vec4 a = colour(texelFetch(f, clamp(i0, ivec2(0), mx), 0));
  vec4 b = colour(texelFetch(f, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0));
  vec4 c = colour(texelFetch(f, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0));
  vec4 d = colour(texelFetch(f, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0));
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}
void main() {
  vec4 now = sampleColour(uField, (vPlan - uGrid.xy) / uGrid.z, uSize);
  if (uMix >= 1.0) { outColour = now; return; }
  vec4 before = sampleColour(uPrev, (vPlan - uPrevGrid.xy) / uPrevGrid.z, uPrevSize);
  outColour = mix(before, now, uMix);
}`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  grid: FieldGrid | null;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? 'compile failed'}`);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`program: ${gl.getProgramInfoLog(prog) ?? 'link failed'}`);
  return prog;
}

export class GlRenderer implements FieldRenderer {
  readonly kind = 'webgl2';
  /** Every pass runs on this thread, so a field is ready as soon as it is set. */
  readonly busy = false;
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #weights: WebGLProgram;
  readonly #colour: WebGLProgram;
  readonly #quad: WebGLBuffer;
  readonly #idx: WebGLTexture;
  readonly #w: WebGLTexture;
  readonly #vals: WebGLTexture;
  readonly #outline: WebGLTexture;
  readonly #ramp: WebGLTexture;
  readonly #targets: [Target, Target];

  #other(): 0 | 1 {
    return this.#cur === 0 ? 1 : 0;
  }
  #cur: 0 | 1 = 0;
  #layout: FieldPlan | null = null;
  #mesh: FieldMesh | null = null;
  readonly #u = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  /** Throws when WebGL2 or float render targets are missing (the caller falls back to Canvas2D). */
  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error('no WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float render targets');
    this.#canvas = canvas;
    this.#gl = gl;
    this.#weights = compile(gl, FIELD_VS, WEIGHTS_FS);
    this.#colour = compile(gl, COLOUR_VS, COLOUR_FS);
    this.#quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.#idx = this.#dataTexture();
    this.#w = this.#dataTexture();
    this.#vals = this.#dataTexture();
    this.#outline = this.#dataTexture();
    this.#ramp = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#ramp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#targets = [this.#target(), this.#target()];
  }

  #dataTexture(): WebGLTexture {
    const gl = this.#gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    return tex;
  }

  #target(): Target {
    const gl = this.#gl;
    const tex = this.#dataTexture();
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, grid: null };
  }

  #loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.#u.get(prog);
    if (!m) this.#u.set(prog, (m = new Map()));
    if (!m.has(name)) m.set(name, this.#gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  #upload(tex: WebGLTexture, data: Float32Array, width: number, height = 1): void {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      Math.max(1, width),
      height,
      0,
      gl.RGBA,
      gl.FLOAT,
      data.length ? data : new Float32Array(4 * height),
    );
  }

  setRamp(lut: Uint8Array): void {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#ramp);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  setLayout(layout: Layout, fade: boolean): void {
    const { field, signal, grid, outline } = layout;
    if (signal) this.#setSignal(signal, grid, outline, fade);
    else if (field) this.#setWeights(field, outline, fade);
    this.#mesh = layout.mesh;
  }

  /**
   * A new sensor layout: upload the per-cell weights (field-plan.ts). With `keepPrevious` the
   * current field becomes the cross-fade source.
   */
  #setWeights(plan: FieldPlan, outline: readonly Point[], keepPrevious: boolean): void {
    const { grid } = plan;
    this.#begin(grid, outline, keepPrevious);
    const cells = grid.nx * grid.ny;
    const idx = new Float32Array(cells * 4);
    const w = new Float32Array(cells * 4);
    for (let c = 0; c < cells; c++) {
      for (let k = 0; k < 3; k++) {
        idx[c * 4 + k] = plan.idx[c * 3 + k]!;
        w[c * 4 + k] = plan.w[c * 3 + k]!;
      }
      idx[c * 4 + 3] = plan.conf[c]!;
      w[c * 4 + 3] = plan.fade[c]!;
    }
    this.#upload(this.#idx, idx, grid.nx, grid.ny);
    this.#upload(this.#w, w, grid.nx, grid.ny);
    this.#layout = plan;
  }

  /** Switch field targets (keeping the current one for a cross-fade) and upload the outline. */
  #begin(grid: FieldGrid, outline: readonly Point[], keepPrevious: boolean): Target {
    const gl = this.#gl;
    if (keepPrevious && this.#targets[this.#cur].grid) this.#cur = this.#other();
    else this.#targets[this.#other()].grid = null;
    const t = this.#targets[this.#cur];
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, grid.nx, grid.ny, 0, gl.RGBA, gl.FLOAT, null);
    t.grid = grid;
    const out = new Float32Array(outline.length * 4);
    outline.forEach(([x, y], i) => out.set([x, y, 0, 0], i * 4));
    this.#upload(this.#outline, out, outline.length);
    this.#layout = null;
    return t;
  }

  /** Bind a field target and the uniforms every field pass shares. */
  #fieldPass(prog: WebGLProgram, t: Target, grid: FieldGrid, outlineCount: number): void {
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, grid.nx, grid.ny);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.#outline);
    gl.uniform1i(this.#loc(prog, 'uOutline'), 2);
    gl.uniform1i(this.#loc(prog, 'uOutlineCount'), outlineCount >= 3 ? outlineCount : 0);
    gl.uniform3f(this.#loc(prog, 'uGrid'), grid.x0, grid.y0, grid.cell);
    gl.uniform2f(this.#loc(prog, 'uFade'), OUTSIDE_ALPHA, FADE_DISTANCE);
  }

  #signal: WebGLProgram | null = null;
  #walls: WebGLTexture | null = null;

  /**
   * The signal layer: trace the whole field in one pass from the packed walls and sources
   * (compiled the first time). With `keepPrevious` the current field becomes the cross-fade source.
   */
  #setSignal(
    input: SignalInput,
    grid: FieldGrid,
    outline: readonly Point[],
    keepPrevious: boolean,
  ): void {
    const gl = this.#gl;
    const prog = (this.#signal ??= compile(gl, FIELD_VS, SIGNAL_FS));
    this.#walls ??= this.#dataTexture();
    const t = this.#begin(grid, outline, keepPrevious);
    const n = Math.min(MAX_SIGNAL_SEGMENTS, input.walls.length / SEG);
    // Two rows: the segment ends, then its loss.
    const walls = new Float32Array(Math.max(1, n) * 8);
    for (let w = 0; w < n; w++) {
      walls.set(input.walls.subarray(w * SEG, w * SEG + 4), w * 4);
      walls[(Math.max(1, n) + w) * 4] = input.walls[w * SEG + 4]!;
    }
    this.#upload(this.#walls, walls, Math.max(1, n), 2);
    const k = Math.min(MAX_SIGNAL_SOURCES, input.aps.length / SRC);
    const aps = new Float32Array(MAX_SIGNAL_SOURCES * 4);
    for (let i = 0; i < k; i++) aps.set(input.aps.subarray(i * SRC, i * SRC + SRC), i * 4);
    this.#fieldPass(prog, t, grid, outline.length);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#walls);
    gl.uniform1i(this.#loc(prog, 'uWalls'), 0);
    gl.uniform1i(this.#loc(prog, 'uWallCount'), n);
    gl.uniform1i(this.#loc(prog, 'uApCount'), k);
    gl.uniform4fv(this.#loc(prog, 'uAps'), aps);
    gl.uniform2f(this.#loc(prog, 'uModel'), SIGNAL_N, SIGNAL_FLOOR);
    this.#drawQuad(prog, [-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Reading values changed: recompute the field target. */
  setValues(values: number[]): void {
    const gl = this.#gl;
    const L = this.#layout;
    if (!L || !this.#mesh) return;
    const nodeVals = nodeValues(this.#mesh, values);
    const vals = new Float32Array(Math.max(1, L.nodes) * 4);
    for (let i = 0; i < L.nodes; i++) vals[i * 4] = nodeVals[i]!;
    this.#upload(this.#vals, vals, L.nodes);
    const p = this.#weights;
    this.#fieldPass(p, this.#targets[this.#cur], L.grid, 0);
    [this.#idx, this.#w, this.#vals].forEach((t, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(this.#loc(p, ['uIdx', 'uW', 'uVals'][unit]!), unit);
    });
    this.#drawQuad(p, [-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  readonly #clipQuad = new Float32Array(8);
  #drawQuad(prog: WebGLProgram, corners: number[] | null): void {
    const gl = this.#gl;
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    if (corners) {
      this.#clipQuad.set(corners);
      gl.bufferData(gl.ARRAY_BUFFER, this.#clipQuad, gl.DYNAMIC_DRAW);
    } else
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(loc);
  }

  /** Pass 2: colour the field into the canvas for the current view. */
  draw(view: View, domain: readonly [number, number], opacity: number, mix: number): void {
    const gl = this.#gl;
    const w = this.#canvas.width;
    const h = this.#canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const cur = this.#targets[this.#cur];
    const prev = this.#targets[this.#other()];
    if (!cur.grid) return;
    const g = cur.grid;
    const cp = this.#colour;
    gl.useProgram(cp);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur.tex);
    gl.uniform1i(this.#loc(cp, 'uField'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev.grid ? prev.tex : cur.tex);
    gl.uniform1i(this.#loc(cp, 'uPrev'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.#ramp);
    gl.uniform1i(this.#loc(cp, 'uRamp'), 2);
    gl.uniform3f(this.#loc(cp, 'uGrid'), g.x0, g.y0, g.cell);
    gl.uniform2f(this.#loc(cp, 'uSize'), g.nx, g.ny);
    // The previous field may have another grid; it is sampled in its own cell space.
    const pg = prev.grid ?? g;
    gl.uniform3f(this.#loc(cp, 'uPrevGrid'), pg.x0, pg.y0, pg.cell);
    gl.uniform2f(this.#loc(cp, 'uPrevSize'), pg.nx, pg.ny);
    gl.uniform4f(this.#loc(cp, 'uView'), view.x, view.y, view.w, view.h);
    gl.uniform2f(this.#loc(cp, 'uDomain'), domain[0], domain[1]);
    gl.uniform1f(this.#loc(cp, 'uOpacity'), opacity);
    gl.uniform1f(this.#loc(cp, 'uMix'), prev.grid ? mix : 1);
    gl.uniform2f(this.#loc(cp, 'uNoData'), NO_DATA_GREY, NO_DATA_ALPHA);
    this.#drawQuad(cp, null);
  }

  /** Forget the previous field once a cross-fade finishes. */
  dropPrevious(): void {
    this.#targets[this.#other()].grid = null;
  }

  readField(): Float32Array | null {
    const gl = this.#gl;
    const t = this.#targets[this.#cur];
    if (!t.grid) return null;
    const cells = t.grid.nx * t.grid.ny;
    const rgba = new Float32Array(cells * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, t.grid.nx, t.grid.ny, gl.RGBA, gl.FLOAT, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return rgba.filter((_, i) => i % 4 < 3);
  }

  dispose(): void {
    this.#gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
