// The WebGL2 heatmap renderer, hand-written (docs/render-design.md, "Pipeline"):
// pass 1a, a full-grid fragment pass: nearest hull edge (clamped lerp), confidence and outside fade
//   into an RGBA32F field target (value, confidence, fade);
// pass 1b, the Delaunay mesh with a per-vertex value, so the rasteriser does the barycentric
//   interpolation, overwriting the value channel inside the hull;
// or, for the signal layer, one ray-tracing pass over the grid into the same target;
// pass 2, the colour pass: bilinear field sample, 256x1 ramp, confidence and fade as alpha, the
//   view transform, and a cross-fade with the previous field.
import {
  CONF_FAR,
  CONF_MIN,
  CONF_NEAR,
  FADE_DISTANCE,
  OUTSIDE_ALPHA,
  WALL_INFLUENCE,
  type FieldGrid,
  type FieldMesh,
} from './field';
import type { Point } from './plan';
import {
  MAX_SIGNAL_SEGMENTS,
  MAX_SIGNAL_SOURCES,
  SEG,
  SIGNAL_FLOOR,
  SIGNAL_N,
  SRC,
  type SignalInput,
} from './signal';
import type { View } from './viewport';

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

const FIELD_FS = `${HEAD}
uniform sampler2D uNodes;   // x, y, value per node
uniform sampler2D uEdges;   // node indices a, b per edge
uniform int uNodeCount;
uniform int uEdgeCount;
uniform vec3 uConf;         // near, far, min
uniform float uWallInfluence; // reserved hook: walls do not bend the field (always 0)
void main() {
  vec2 p = uGrid.xy + gl_FragCoord.xy * uGrid.z;
  float best = 1e30;
  float value = 0.0;
  for (int e = 0; e < 16384; e++) {
    if (e >= uEdgeCount) break;
    vec4 ed = texelFetch(uEdges, ivec2(e, 0), 0);
    vec4 a = texelFetch(uNodes, ivec2(int(ed.x), 0), 0);
    vec4 b = texelFetch(uNodes, ivec2(int(ed.y), 0), 0);
    vec2 ab = b.xy - a.xy;
    float l2 = dot(ab, ab);
    float t = l2 > 0.0 ? clamp(dot(p - a.xy, ab) / l2, 0.0, 1.0) : 0.0;
    vec2 d = p - a.xy - t * ab;
    float d2 = dot(d, d);
    if (d2 < best) { best = d2; value = mix(a.z, b.z, t); }
  }
  float near = 1e30;
  for (int i = 0; i < 16384; i++) {
    if (i >= uNodeCount) break;
    vec2 q = texelFetch(uNodes, ivec2(i, 0), 0).xy - p;
    near = min(near, dot(q, q));
  }
  float conf = uNodeCount > 0 ? 1.0 - (1.0 - uConf.z) * smoothstep(uConf.x, uConf.y, sqrt(near)) : 0.0;
  outField = vec4(value + 0.0 * uWallInfluence, conf, fadeAt(p), 1.0);
}`;

// The signal pass (signalAt in signal.ts, line for line): per source, log-distance loss from its
// level at 1 m, minus each wall segment the ray from it crosses; the strongest source wins.
const SIGNAL_FS = `${HEAD}
uniform sampler2D uWalls;   // row 0: ax, ay, bx, by; row 1: loss in dB
uniform int uWallCount;
uniform int uApCount;
uniform vec4 uAps[${MAX_SIGNAL_SOURCES}]; // x, y, level at 1 m
uniform vec2 uModel;        // path-loss exponent, floor
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

// The triangles: rasterised over the grid, each vertex carrying its triangle's three node
// indices. The fragment takes barycentric weights from those nodes (positions and values in
// uNodes), the same sum the CPU reference makes; interpolated varyings would drift by a little
// in the long thin triangles along the hull, where the gradient is steep.
const MESH_VS = `#version 300 es
in vec2 aPos;
in uvec3 aTri;
uniform vec3 uGrid;
uniform vec2 uSize;
flat out uvec3 vTri;
void main() {
  vTri = aTri;
  gl_Position = vec4((aPos - uGrid.xy) / (uGrid.z * uSize) * 2.0 - 1.0, 0.0, 1.0);
}`;

const MESH_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uNodes;
uniform vec3 uGrid;
flat in uvec3 vTri;
out vec4 outField;
float orient(vec2 a, vec2 b, vec2 c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
void main() {
  vec2 p = uGrid.xy + gl_FragCoord.xy * uGrid.z;
  vec4 a = texelFetch(uNodes, ivec2(int(vTri.x), 0), 0);
  vec4 b = texelFetch(uNodes, ivec2(int(vTri.y), 0), 0);
  vec4 c = texelFetch(uNodes, ivec2(int(vTri.z), 0), 0);
  float area = orient(a.xy, b.xy, c.xy);
  float wa = orient(b.xy, c.xy, p) / area;
  float wb = orient(c.xy, a.xy, p) / area;
  float wc = 1.0 - wa - wb;
  outField = vec4(wa * a.z + wb * b.z + wc * c.z, 0.0, 0.0, 1.0);
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
in vec2 vPlan;
out vec4 outColour;
// Bilinear by hand: linear filtering of float textures is an optional extension.
vec4 sampleField(sampler2D f, vec2 cellPos, vec2 size) {
  vec2 q = cellPos - 0.5;
  vec2 fl = floor(q);
  vec2 fr = q - fl;
  ivec2 i0 = ivec2(fl);
  ivec2 mx = ivec2(size) - 1;
  vec4 a = texelFetch(f, clamp(i0, ivec2(0), mx), 0);
  vec4 b = texelFetch(f, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0);
  vec4 c = texelFetch(f, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0);
  vec4 d = texelFetch(f, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0);
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}
vec4 colour(vec4 s) {
  float t = clamp((s.x - uDomain.x) / max(1e-6, uDomain.y - uDomain.x), 0.0, 1.0);
  vec3 rgb = texture(uRamp, vec2((t * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  float a = uOpacity * s.y * s.z;
  return vec4(rgb * a, a);
}
void main() {
  vec4 now = colour(sampleField(uField, (vPlan - uGrid.xy) / uGrid.z, uSize));
  if (uMix >= 1.0) { outColour = now; return; }
  vec4 before = colour(sampleField(uPrev, (vPlan - uPrevGrid.xy) / uPrevGrid.z, uPrevSize));
  outColour = mix(before, now, uMix);
}`;

export interface Target {
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

export class GlRenderer {
  readonly gl: WebGL2RenderingContext;
  #field: WebGLProgram;
  #mesh: WebGLProgram;
  #colour: WebGLProgram;
  #quad: WebGLBuffer;
  #meshVao: WebGLVertexArrayObject;
  #meshPos: WebGLBuffer;
  #meshTri: WebGLBuffer;
  #nodes: WebGLTexture;
  #edges: WebGLTexture;
  #outline: WebGLTexture;
  #ramp: WebGLTexture;
  #targets: [Target, Target];

  #other(): 0 | 1 {
    return this.#cur === 0 ? 1 : 0;
  }
  #cur: 0 | 1 = 0;
  #layout: { mesh: FieldMesh; grid: FieldGrid; outlineCount: number } | null = null;
  #nodeData = new Float32Array(0);
  #u = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  /** Throws when WebGL2 or float render targets are missing (the caller falls back to Canvas2D). */
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error('no WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no float render targets');
    this.gl = gl;
    this.#field = compile(gl, FIELD_VS, FIELD_FS);
    this.#mesh = compile(gl, MESH_VS, MESH_FS);
    this.#colour = compile(gl, COLOUR_VS, COLOUR_FS);
    this.#quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.#meshPos = gl.createBuffer();
    this.#meshTri = gl.createBuffer();
    this.#meshVao = gl.createVertexArray();
    gl.bindVertexArray(this.#meshVao);
    const posLoc = gl.getAttribLocation(this.#mesh, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#meshPos);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    const triLoc = gl.getAttribLocation(this.#mesh, 'aTri');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#meshTri);
    gl.enableVertexAttribArray(triLoc);
    gl.vertexAttribIPointer(triLoc, 3, gl.UNSIGNED_INT, 0, 0);
    gl.bindVertexArray(null);
    this.#nodes = this.#dataTexture();
    this.#edges = this.#dataTexture();
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
    const gl = this.gl;
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
    const gl = this.gl;
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
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  #upload(tex: WebGLTexture, data: Float32Array, width: number, height = 1): void {
    const gl = this.gl;
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
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#ramp);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  /**
   * A new sensor layout: upload geometry. With `keepPrevious` the current field becomes the
   * cross-fade source.
   */
  setLayout(
    mesh: FieldMesh,
    grid: FieldGrid,
    outline: readonly Point[],
    keepPrevious: boolean,
  ): void {
    const gl = this.gl;
    this.#begin(grid, outline, keepPrevious);
    this.#nodeData = new Float32Array(mesh.nodes.length * 4);
    mesh.nodes.forEach(([x, y], i) => this.#nodeData.set([x, y, 0, 0], i * 4));
    const edges = new Float32Array((mesh.edges.length / 2) * 4);
    for (let e = 0; e < mesh.edges.length / 2; e++)
      edges.set([mesh.edges[e * 2]!, mesh.edges[e * 2 + 1]!, 0, 0], e * 4);
    this.#upload(this.#edges, edges, mesh.edges.length / 2);
    // One vertex per triangle corner, each with its triangle's node indices.
    const pos = new Float32Array(mesh.tris.length * 2);
    const tri = new Uint32Array(mesh.tris.length * 3);
    for (let k = 0; k < mesh.tris.length; k++) {
      const [x, y] = mesh.nodes[mesh.tris[k]!]!;
      pos[k * 2] = x;
      pos[k * 2 + 1] = y;
      const t0 = k - (k % 3);
      tri.set([mesh.tris[t0]!, mesh.tris[t0 + 1]!, mesh.tris[t0 + 2]!], k * 3);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#meshPos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#meshTri);
    gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);
    this.#layout = { mesh, grid, outlineCount: outline.length };
  }

  /** Switch field targets (keeping the current one for a cross-fade) and upload the outline. */
  #begin(grid: FieldGrid, outline: readonly Point[], keepPrevious: boolean): Target {
    const gl = this.gl;
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
    const gl = this.gl;
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
  setSignal(
    input: SignalInput,
    grid: FieldGrid,
    outline: readonly Point[],
    keepPrevious: boolean,
  ): void {
    const gl = this.gl;
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

  /** Node values changed: recompute the field target (passes 1a and 1b). */
  setValues(nodeVals: ArrayLike<number>): void {
    const gl = this.gl;
    const L = this.#layout;
    if (!L) return;
    const { mesh, grid } = L;
    for (let i = 0; i < mesh.nodes.length; i++) this.#nodeData[i * 4 + 2] = nodeVals[i]!;
    this.#upload(this.#nodes, this.#nodeData, mesh.nodes.length);
    // 1a: the hull-projection pass over every cell.
    const fp = this.#field;
    this.#fieldPass(fp, this.#targets[this.#cur], grid, L.outlineCount);
    const tex = (unit: number, texture: WebGLTexture, name: string): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(this.#loc(fp, name), unit);
    };
    tex(0, this.#nodes, 'uNodes');
    tex(1, this.#edges, 'uEdges');
    gl.uniform1i(this.#loc(fp, 'uNodeCount'), mesh.nodes.length);
    gl.uniform1i(this.#loc(fp, 'uEdgeCount'), mesh.edges.length / 2);
    gl.uniform3f(this.#loc(fp, 'uConf'), CONF_NEAR, CONF_FAR, CONF_MIN);
    gl.uniform1f(this.#loc(fp, 'uWallInfluence'), WALL_INFLUENCE);
    this.#drawQuad(fp, [-1, -1, 1, -1, -1, 1, 1, 1]);
    // 1b: the triangles, value channel only.
    if (mesh.tris.length > 0) {
      const mp = this.#mesh;
      gl.useProgram(mp);
      gl.uniform3f(this.#loc(mp, 'uGrid'), grid.x0, grid.y0, grid.cell);
      gl.uniform2f(this.#loc(mp, 'uSize'), grid.nx, grid.ny);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.#nodes);
      gl.uniform1i(this.#loc(mp, 'uNodes'), 0);
      gl.colorMask(true, false, false, false);
      gl.bindVertexArray(this.#meshVao);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.tris.length);
      gl.bindVertexArray(null);
      gl.colorMask(true, true, true, true);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  #clipQuad = new Float32Array(8);
  #drawQuad(prog: WebGLProgram, corners: number[] | null): void {
    const gl = this.gl;
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
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
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
    this.#drawQuad(cp, null);
  }

  /** Forget the previous field once a cross-fade finishes. */
  dropPrevious(): void {
    this.#targets[this.#other()].grid = null;
  }

  /** The current field target (for the debug hooks). */
  get target(): Target {
    return this.#targets[this.#cur];
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
