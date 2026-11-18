import type { Rect } from '../types';
import { RECT_STRIDE, polylineStrip, type RectBatch } from './batch';
import { parseColor, type Rgba } from './color';
import { isSoftwareRenderer, type Painter, type PixelImage, type PowerPreference } from './painter';

/*
 * WebGL2 backend (raw WebGL2, no library): three tiny programs.
 * - rects: one unit quad, instanced per rect (x, y, w, h, rgba) — candles, wicks, footprint cells,
 *   volume / profile bars, grid lines.
 * - strips: polylines expanded to triangle strips (indicator lines), one uniform colour.
 * - image: a textured quad (heatmap pixel buffer uploaded as an RGBA8 texture).
 * Coordinates are CSS px; the vertex shaders map them to clip space so DPR only sets the viewport.
 */

const RECT_VS = `#version 300 es
layout(location=0) in vec2 a_unit;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec4 a_color;
uniform vec2 u_view;
out vec4 v_color;
void main() {
  vec2 p = a_rect.xy + a_unit * a_rect.zw;
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
  v_color = a_color;
}`;

const COLOR_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() { o = vec4(v_color.rgb * v_color.a, v_color.a); }`;

const STRIP_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
uniform vec2 u_view;
uniform vec4 u_color;
out vec4 v_color;
void main() {
  gl_Position = vec4(a_pos.x / u_view.x * 2.0 - 1.0, 1.0 - a_pos.y / u_view.y * 2.0, 0.0, 1.0);
  v_color = u_color;
}`;

const IMAGE_VS = `#version 300 es
layout(location=0) in vec2 a_unit;
uniform vec2 u_view;
uniform vec4 u_dst;
uniform vec4 u_uv;
out vec2 v_uv;
void main() {
  vec2 p = u_dst.xy + a_unit * u_dst.zw;
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
  v_uv = u_uv.xy + a_unit * u_uv.zw;
}`;

const IMAGE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv); }`;

interface Prog {
  p: WebGLProgram;
  view: WebGLUniformLocation | null;
  extra: Record<string, WebGLUniformLocation | null>;
}

interface Tex {
  tex: WebGLTexture;
  version: number;
  w: number;
  h: number;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string, uniforms: string[]): Prog {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error('createShader failed');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(`shader: ${gl.getShaderInfoLog(s) ?? '?'}`);
    return s;
  };
  const p = gl.createProgram();
  if (!p) throw new Error('createProgram failed');
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`link: ${gl.getProgramInfoLog(p) ?? '?'}`);
  const extra: Prog['extra'] = {};
  for (const u of uniforms) extra[u] = gl.getUniformLocation(p, u);
  return { p, view: gl.getUniformLocation(p, 'u_view'), extra };
}

export interface GlInfo {
  renderer: string;
  software: boolean;
}

/** WebGL2 painter bound to one canvas. Create with `WebGL2Painter.create` (null on failure). */
export class WebGL2Painter implements Painter {
  readonly kind = 'webgl2' as const;
  readonly info: GlInfo;
  private rectProg!: Prog;
  private stripProg!: Prog;
  private imageProg!: Prog;
  private unit!: WebGLBuffer;
  private inst!: WebGLBuffer;
  private strip!: WebGLBuffer;
  private rectVao!: WebGLVertexArrayObject;
  private stripVao!: WebGLVertexArrayObject;
  private imageVao!: WebGLVertexArrayObject;
  private instCap = 0;
  private stripCap = 0;
  private textures = new WeakMap<object, Tex>();
  private live: Tex[] = [];
  private w = 1;
  private h = 1;
  private dpr = 1;
  /** Draw calls issued since `begin` (debug overlay / bench). */
  drawCalls = 0;
  /** Instances uploaded since `begin`. */
  instances = 0;

  private constructor(readonly gl: WebGL2RenderingContext) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? '',
    );
    this.info = { renderer: name, software: isSoftwareRenderer(name) };
    this.init();
  }

  /** Creates the context and programs; null when WebGL2 is unavailable or setup fails. */
  static create(
    canvas: HTMLCanvasElement,
    powerPreference: PowerPreference = 'default',
  ): WebGL2Painter | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        // Snapshots (camera / clipboard) read the canvas outside the frame.
        preserveDrawingBuffer: true,
        powerPreference,
      }) as WebGL2RenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl || typeof gl.createVertexArray !== 'function') return null;
    try {
      return new WebGL2Painter(gl);
    } catch {
      return null;
    }
  }

  /** (Re)creates programs and buffers — also after `webglcontextrestored`. */
  init(): void {
    const gl = this.gl;
    this.rectProg = compile(gl, RECT_VS, COLOR_FS, []);
    this.stripProg = compile(gl, STRIP_VS, COLOR_FS, ['u_color']);
    this.imageProg = compile(gl, IMAGE_VS, IMAGE_FS, ['u_dst', 'u_uv', 'u_tex']);
    this.unit = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unit);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.inst = gl.createBuffer()!;
    this.strip = gl.createBuffer()!;
    this.instCap = 0;
    this.stripCap = 0;
    this.textures = new WeakMap();
    this.live = [];

    this.rectVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unit);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, RECT_STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, RECT_STRIDE * 4, 16);
    gl.vertexAttribDivisor(2, 1);

    this.stripVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.stripVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.strip);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.imageVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.imageVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unit);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  isLost(): boolean {
    return this.gl.isContextLost();
  }

  /** Starts a frame: viewport, blending and the background clear. */
  begin(widthCss: number, heightCss: number, dpr: number, clear: Rgba): void {
    const gl = this.gl;
    this.w = Math.max(1, widthCss);
    this.h = Math.max(1, heightCss);
    this.dpr = dpr;
    this.drawCalls = 0;
    this.instances = 0;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  setClip(r: Rect | null): void {
    const gl = this.gl;
    if (!r) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    const d = this.dpr;
    const x = Math.max(0, Math.floor(r.x * d));
    const y = Math.max(0, Math.floor((this.h - (r.y + r.h)) * d));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, Math.max(0, Math.ceil(r.w * d)), Math.max(0, Math.ceil(r.h * d)));
  }

  private use(p: Prog): void {
    this.gl.useProgram(p.p);
    this.gl.uniform2f(p.view, this.w, this.h);
  }

  rects(b: RectBatch): void {
    if (!b.count) return;
    const gl = this.gl;
    const data = b.view();
    this.use(this.rectProg);
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    if (data.byteLength > this.instCap) {
      this.instCap = Math.max(data.byteLength, this.instCap * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.instCap, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
    gl.bindVertexArray(null);
    this.drawCalls++;
    this.instances += b.count;
  }

  /** Draws a prepared triangle strip (see `polylineStrip` / `joinStrips`). */
  stripVerts(verts: Float32Array, color: string, alpha = 1): void {
    if (verts.length < 8) return;
    const gl = this.gl;
    const c = parseColor(color);
    this.use(this.stripProg);
    gl.uniform4f(this.stripProg.extra.u_color!, c[0], c[1], c[2], c[3] * alpha);
    gl.bindVertexArray(this.stripVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.strip);
    if (verts.byteLength > this.stripCap) {
      this.stripCap = Math.max(verts.byteLength, this.stripCap * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.stripCap, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, verts.length / 2);
    gl.bindVertexArray(null);
    this.drawCalls++;
  }

  polyline(pts: ArrayLike<number>, n: number, color: string, width: number, alpha = 1): void {
    this.stripVerts(polylineStrip(pts, n, width), color, alpha);
  }

  image(img: PixelImage, src: Rect, dst: Rect, smoothing: boolean): void {
    if (img.width < 1 || img.height < 1) return;
    const gl = this.gl;
    let t = this.textures.get(img.key);
    if (!t) {
      t = { tex: gl.createTexture()!, version: -1, w: 0, h: 0 };
      this.textures.set(img.key, t);
      this.live.push(t);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (t.version !== img.version || t.w !== img.width || t.h !== img.height) {
      const px = new Uint8Array(
        img.pixels.buffer,
        img.pixels.byteOffset,
        img.width * img.height * 4,
      );
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (t.w !== img.width || t.h !== img.height)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          img.width,
          img.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        );
      else
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          img.width,
          img.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        );
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t.version = img.version;
      t.w = img.width;
      t.h = img.height;
    }
    const f = smoothing ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    const p = this.imageProg;
    this.use(p);
    gl.uniform4f(p.extra.u_dst!, dst.x, dst.y, dst.w, dst.h);
    gl.uniform4f(
      p.extra.u_uv!,
      src.x / img.width,
      src.y / img.height,
      src.w / img.width,
      src.h / img.height,
    );
    gl.uniform1i(p.extra.u_tex!, 0);
    gl.bindVertexArray(this.imageVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    this.drawCalls++;
  }

  /** Releases GPU objects (the context itself goes away with its canvas). */
  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    for (const t of this.live) gl.deleteTexture(t.tex);
    this.live = [];
    gl.deleteBuffer(this.unit);
    gl.deleteBuffer(this.inst);
    gl.deleteBuffer(this.strip);
    gl.deleteVertexArray(this.rectVao);
    gl.deleteVertexArray(this.stripVao);
    gl.deleteVertexArray(this.imageVao);
    gl.deleteProgram(this.rectProg.p);
    gl.deleteProgram(this.stripProg.p);
    gl.deleteProgram(this.imageProg.p);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Cached probe: can this browser create a WebGL2 context, and is it a hardware GPU? */
let probeCache: { webgl2: boolean; hardware: boolean; renderer: string } | null = null;
export function probeWebGL2(): { webgl2: boolean; hardware: boolean; renderer: string } {
  if (probeCache) return probeCache;
  let res = { webgl2: false, hardware: false, renderer: '' };
  try {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const p = WebGL2Painter.create(c);
      if (p) {
        res = { webgl2: true, hardware: !p.info.software, renderer: p.info.renderer };
        p.dispose();
      }
    }
  } catch {
    /* keep false */
  }
  probeCache = res;
  return res;
}

/** Test hook: forget the probe result. */
export function resetWebGL2Probe(): void {
  probeCache = null;
}
