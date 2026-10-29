import { buildCurveLut } from '../curves';
import { shoulderRange, toeRange } from '../film';
import { outputSize, outputToSource, type Affine } from '../geometry';
import { BRUSH_LONG, brushSize, drawDab } from '../brush';
import { HSL_BANDS, sectionModified, type BrushMask, type EditState } from '../state';
import { compile, ensureTarget, fullscreenVao, setSampling, type GL, type Program, type Target } from './glutil';
import { BLIT_FS, BLUR_FS, BRIGHT_FS, DEVELOP_FS, DISPLAY_FS, FILM_FS, STATS_FS } from './shaders';

const MAX_MASKS = 8;
const MAX_SPOTS = 256;
const STAT_LONG = 512;

export interface View {
  /** 畫布裝置像素 */
  canvasW: number;
  canvasH: number;
  /** 照片矩形（裝置像素，左上原點） */
  rect: [number, number, number, number];
  /** 這個 x（裝置像素）以左顯示原圖；-1 = 不分割 */
  splitX: number;
}

export interface ProcessOptions {
  /** 工作解析度 / 輸出全解析度 */
  scale: number;
  /** 裁切模式時顯示完整畫框 */
  ignoreCrop?: boolean;
  /** 要以紅膜顯示的遮罩索引，-1 = 不顯示 */
  showMask?: number;
}

interface TargetSet {
  dev: Target | null;
  halo1: Target | null;
  halo2: Target | null;
  out: Target | null;
}

interface BrushLayer {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  drawn: number;
  first: string;
}

const mat3 = (m: Affine) => new Float32Array([m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1]);

function makeCanvas(w: number, h: number) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Renderer {
  readonly gl: GL;
  private vao: WebGLVertexArrayObject;
  private p: Record<'stats' | 'blur' | 'bright' | 'develop' | 'film' | 'display' | 'blit', Program>;
  private srcTex: WebGLTexture | null = null;
  srcW = 0;
  srcH = 0;
  private statS: Target | null = null;
  private statL: Target | null = null;
  private tmp: Target | null = null;
  private lutTex: WebGLTexture;
  private spotTex: WebGLTexture;
  private brushTex: WebGLTexture;
  private brushDims: [number, number] = [1, 1];
  private brushLayers = new Map<string, BrushLayer>();
  private layerOwner: (string | null)[] = new Array(MAX_MASKS).fill(null);
  private lutKey = '';
  private preview: TargetSet = { dev: null, halo1: null, halo2: null, out: null };
  private side: TargetSet = { dev: null, halo1: null, halo2: null, out: null };
  private small: Target | null = null;
  private state: EditState | null = null;
  private lastOpts: ProcessOptions = { scale: 1 };
  readonly maxSize: number;
  /** 最近一次處理的尺寸（裝置像素）與完整輸出尺寸 */
  workW = 0;
  workH = 0;
  fullW = 0;
  fullH = 0;
  geo: Affine = [1, 0, 0, 0, 1, 0];

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true }) as GL | null;
    if (!gl) throw new Error('這個瀏覽器不支援 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('這個瀏覽器不支援浮點渲染（EXT_color_buffer_float）');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.vao = fullscreenVao(gl);
    this.p = {
      stats: compile(gl, STATS_FS, 'stats'),
      blur: compile(gl, BLUR_FS, 'blur'),
      bright: compile(gl, BRIGHT_FS, 'bright'),
      develop: compile(gl, DEVELOP_FS, 'develop'),
      film: compile(gl, FILM_FS, 'film'),
      display: compile(gl, DISPLAY_FS, 'display'),
      blit: compile(gl, BLIT_FS, 'blit'),
    };
    this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    setSampling(gl, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 256, 1, 0, gl.RGBA, gl.FLOAT, buildCurveLut({ rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] }));
    this.spotTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.spotTex);
    setSampling(gl, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(8));
    this.brushTex = gl.createTexture()!;
    this.allocBrush(1, 1);
  }

  get hasSource() {
    return !!this.srcTex;
  }

  // ───────────── 來源 ─────────────

  loadSource(img: TexImageSource, w: number, h: number) {
    const gl = this.gl;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcW = w;
    this.srcH = h;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, w, h);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    setSampling(gl, true, true);
    this.srcTex = tex;
    this.computeStats();
    // 換照片：筆刷圖層全部重來
    const [bw, bh] = brushSize(w, h);
    this.allocBrush(bw, bh);
    this.brushLayers.clear();
    this.layerOwner.fill(null);
    this.lutKey = '';
  }

  private computeStats() {
    const gl = this.gl;
    const k = STAT_LONG / Math.max(this.srcW, this.srcH);
    const sw = Math.max(1, Math.round(this.srcW * Math.min(1, k)));
    const sh = Math.max(1, Math.round(this.srcH * Math.min(1, k)));
    this.tmp = ensureTarget(gl, this.tmp, sw, sh, 'f16');
    const base = ensureTarget(gl, null, sw, sh, 'f16');
    this.statS = ensureTarget(gl, this.statS, sw, sh, 'f16');
    this.statL = ensureTarget(gl, this.statL, sw, sh, 'f16');
    this.pass(this.p.stats, base, (u) => {
      this.bindTex(0, this.srcTex!, u('uSrc'));
      gl.uniform1f(u('uLod'), Math.max(0, Math.log2(Math.max(this.srcW, this.srcH) / STAT_LONG)));
    });
    const long = Math.max(sw, sh);
    this.blur(base, this.tmp, this.statS, long * 0.008);
    this.blur(this.statS, this.tmp, this.statL, long * 0.03);
    gl.deleteTexture(base.tex);
    gl.deleteFramebuffer(base.fbo);
  }

  private allocBrush(w: number, h: number) {
    const gl = this.gl;
    gl.deleteTexture(this.brushTex);
    this.brushTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, MAX_MASKS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.brushDims = [w, h];
  }

  // ───────────── 狀態 ─────────────

  setState(s: EditState) {
    this.state = s;
    const gl = this.gl;
    const key = JSON.stringify(s.curves);
    if (key !== this.lutKey) {
      this.lutKey = key;
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.FLOAT, buildCurveLut(s.curves));
    }
    this.syncSpots(s);
    this.syncBrushes(s);
  }

  private syncSpots(s: EditState) {
    const gl = this.gl;
    const spots = s.disabled.spots ? [] : s.spots.slice(0, MAX_SPOTS);
    const n = Math.max(1, spots.length);
    const data = new Float32Array(2 * n * 4);
    spots.forEach((p, i) => {
      data.set([p.x, p.y, p.r, p.feather], i * 8);
      data.set([p.sx, p.sy, p.mode === 'heal' ? 1 : 0, p.opacity], i * 8 + 4);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.spotTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, n, 0, gl.RGBA, gl.FLOAT, data);
  }

  private syncBrushes(s: EditState) {
    if (!this.srcTex) return;
    const gl = this.gl;
    const [bw, bh] = this.brushDims;
    s.masks.slice(0, MAX_MASKS).forEach((m, layer) => {
      if (m.type !== 'brush') return;
      let L = this.brushLayers.get(m.id);
      if (!L) {
        const canvas = makeCanvas(bw, bh);
        const ctx = canvas.getContext('2d') as BrushLayer['ctx'];
        L = { canvas, ctx, drawn: 0, first: '' };
        this.brushLayers.set(m.id, L);
      }
      const changed = this.rasterize(L, m);
      if (changed || this.layerOwner[layer] !== m.id) {
        this.layerOwner[layer] = m.id;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, bw, bh, 1, gl.RED, gl.UNSIGNED_BYTE, L.canvas as TexImageSource);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
    });
  }

  private rasterize(L: BrushLayer, m: BrushMask): boolean {
    const [bw, bh] = this.brushDims;
    const first = m.dabs.length ? JSON.stringify(m.dabs[0]) : '';
    const incremental = m.dabs.length >= L.drawn && first === L.first && L.drawn > 0;
    if (incremental && m.dabs.length === L.drawn) return false;
    if (!incremental) {
      L.ctx.clearRect(0, 0, bw, bh);
      L.drawn = 0;
      L.first = first;
    }
    for (let i = L.drawn; i < m.dabs.length; i++) drawDab(L.ctx, m.dabs[i], bw, bh);
    L.drawn = m.dabs.length;
    return true;
  }

  // ───────────── 處理 ─────────────

  /** 依目前狀態算出結果到預覽緩衝 */
  process(opts: ProcessOptions) {
    this.lastOpts = opts;
    this.runPipeline(this.preview, opts);
  }

  private runPipeline(set: TargetSet, opts: ProcessOptions, stateOverride?: EditState) {
    const s = stateOverride ?? this.state;
    if (!s || !this.srcTex) return;
    const gl = this.gl;
    const ignoreCrop = !!opts.ignoreCrop;
    const [fw, fh] = outputSize(this.srcW, this.srcH, s.geometry, ignoreCrop);
    let scale = Math.min(1, opts.scale, this.maxSize / Math.max(fw, fh));
    const ww = Math.max(1, Math.round(fw * scale));
    const wh = Math.max(1, Math.round(fh * scale));
    scale = ww / fw;
    const geo = outputToSource(this.srcW, this.srcH, s.geometry, ignoreCrop);
    if (set === this.preview) {
      this.workW = ww;
      this.workH = wh;
      this.fullW = fw;
      this.fullH = fh;
      this.geo = geo;
    }
    set.dev = ensureTarget(gl, set.dev, ww, wh, 'f16');
    set.out = ensureTarget(gl, set.out, ww, wh, 'u8');
    const hw = Math.max(1, Math.ceil(ww / 4)), hh = Math.max(1, Math.ceil(wh / 4));
    set.halo1 = ensureTarget(gl, set.halo1, hw, hh, 'f16');
    set.halo2 = ensureTarget(gl, set.halo2, hw, hh, 'f16');

    const showMask = opts.showMask ?? -1;
    this.pass(this.p.develop, set.dev, (u) => this.developUniforms(u, s, geo, showMask));

    const film = s.film.enabled && !s.disabled.film;
    if (film && (s.film.halation > 0 || s.film.bloom > 0)) {
      this.pass(this.p.bright, set.halo1, (u) => {
        this.bindTex(0, set.dev!.tex, u('uTex'));
        gl.uniform2f(u('uSrcPx'), 1 / ww, 1 / wh);
      });
      const r = (0.004 + (s.film.halationRadius / 100) * 0.026) * Math.max(hw, hh);
      this.blur(set.halo1, set.halo2, set.halo1, r);
    }
    this.pass(this.p.film, set.out, (u) => this.filmUniforms(u, s, set, fw, fh, showMask));
  }

  private developUniforms(u: Program['u'], s: EditState, geo: Affine, showMask: number) {
    const gl = this.gl;
    this.bindTex(0, this.srcTex!, u('uSrc'));
    this.bindTex(1, this.statS!.tex, u('uStatS'));
    this.bindTex(2, this.statL!.tex, u('uStatL'));
    this.bindTex(3, this.lutTex, u('uLut'));
    this.bindTex(4, this.spotTex, u('uSpots'));
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.brushTex);
    gl.uniform1i(u('uBrush'), 5);
    gl.uniformMatrix3fv(u('uGeo'), false, mat3(geo));
    gl.uniform2f(u('uSrcSize'), this.srcW, this.srcH);
    gl.uniform1f(u('uLong'), Math.max(this.srcW, this.srcH));

    const off = s.disabled;
    const b = off.basic ? null : s.basic;
    const f = (k: keyof EditState['basic']) => (b ? b[k] : 0);
    gl.uniform1f(u('uExposure'), f('exposure'));
    gl.uniform1f(u('uContrast'), f('contrast'));
    gl.uniform1f(u('uHighlights'), f('highlights'));
    gl.uniform1f(u('uShadows'), f('shadows'));
    gl.uniform1f(u('uWhites'), f('whites'));
    gl.uniform1f(u('uBlacks'), f('blacks'));
    gl.uniform1f(u('uTemp'), f('temp'));
    gl.uniform1f(u('uTint'), f('tint'));
    gl.uniform1f(u('uVibrance'), f('vibrance'));
    gl.uniform1f(u('uSaturation'), f('saturation'));
    gl.uniform1f(u('uClarity'), f('clarity'));
    gl.uniform1f(u('uDehaze'), f('dehaze'));

    gl.uniform1i(u('uCurvesOn'), !off.curves && sectionModified(s, 'curves') ? 1 : 0);
    const hslOn = !off.hsl && sectionModified(s, 'hsl');
    gl.uniform1i(u('uHslOn'), hslOn ? 1 : 0);
    const hsl = new Float32Array(24);
    HSL_BANDS.forEach((band, i) => hsl.set(s.hsl[band].map((v) => v / 100), i * 3));
    gl.uniform3fv(u('uHsl'), hsl);
    const splitOn = !off.split && sectionModified(s, 'split');
    gl.uniform1i(u('uSplitOn'), splitOn ? 1 : 0);
    gl.uniform4f(u('uSplit'), s.split.shadowHue / 360, s.split.shadowSat / 100, s.split.highlightHue / 360, s.split.highlightSat / 100);
    gl.uniform1f(u('uSplitBalance'), s.split.balance / 100);

    gl.uniform1i(u('uSpotCount'), off.spots ? 0 : Math.min(MAX_SPOTS, s.spots.length));

    const masks = off.masks ? [] : s.masks.slice(0, MAX_MASKS);
    const types = new Int32Array(MAX_MASKS);
    const A = new Float32Array(MAX_MASKS * 4), B = new Float32Array(MAX_MASKS * 4);
    const a0 = new Float32Array(MAX_MASKS * 4), a1 = new Float32Array(MAX_MASKS * 4), a2 = new Float32Array(MAX_MASKS * 4);
    masks.forEach((m, i) => {
      const adj = m.visible ? m.adjust : { exposure: 0, contrast: 0, highlights: 0, shadows: 0, temp: 0, tint: 0, saturation: 0, clarity: 0, dehaze: 0 };
      if (m.type === 'linear') {
        types[i] = 0;
        A.set([m.a[0], m.a[1], m.b[0], m.b[1]], i * 4);
      } else if (m.type === 'radial') {
        types[i] = 1;
        A.set([m.cx, m.cy, m.rx, m.ry], i * 4);
        B.set([m.angle, m.feather, 0, 0], i * 4);
      } else {
        types[i] = 2;
      }
      a0.set([adj.exposure, adj.contrast, adj.highlights, adj.shadows], i * 4);
      a1.set([adj.temp, adj.tint, adj.saturation, adj.clarity], i * 4);
      a2.set([adj.dehaze, m.invert ? 1 : 0, i, 0], i * 4);
    });
    gl.uniform1i(u('uMaskCount'), masks.length);
    gl.uniform1iv(u('uMaskType'), types);
    gl.uniform4fv(u('uMaskA'), A);
    gl.uniform4fv(u('uMaskB'), B);
    gl.uniform4fv(u('uMaskAdj0'), a0);
    gl.uniform4fv(u('uMaskAdj1'), a1);
    gl.uniform4fv(u('uMaskAdj2'), a2);
    gl.uniform1i(u('uShowMask'), showMask < masks.length ? showMask : -1);
  }

  private filmUniforms(u: Program['u'], s: EditState, set: TargetSet, fw: number, fh: number, showMask: number) {
    const gl = this.gl;
    const F = s.film;
    const on = F.enabled && !s.disabled.film;
    this.bindTex(0, set.dev!.tex, u('uDev'));
    this.bindTex(1, set.halo1!.tex, u('uHalo'));
    gl.uniform2f(u('uFull'), fw, fh);
    gl.uniform1i(u('uFilmOn'), on ? 1 : 0);
    gl.uniform1i(u('uShowMask'), showMask);
    gl.uniform1f(u('uStrength'), F.strength / 100);
    gl.uniform1f(u('uFilmExposure'), F.filmExposure);
    gl.uniform1f(u('uGamma'), F.gamma);
    gl.uniform1f(u('uToeR'), toeRange(F.toe));
    gl.uniform1f(u('uShoulderR'), shoulderRange(F.shoulder));
    gl.uniform1f(u('uFade'), (F.fade / 100) * 0.06);
    const c = (F.crosstalk / 100) * 0.35;
    // 列：每個感光層從其他層「借」到的曝光
    const N = [0, 0.7, 0.3, 0.45, 0, 0.55, 0.25, 0.75, 0];
    const M = [0, 1, 2].flatMap((r) => [0, 1, 2].map((k) => (r === k ? 1 - c : 0) + c * N[r * 3 + k]));
    // GLSL 是行優先 → 轉置
    gl.uniformMatrix3fv(u('uCross'), false, new Float32Array([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]));
    gl.uniform1f(u('uFilmSat'), F.saturation / 100);
    gl.uniform1i(u('uMono'), F.mono ? 1 : 0);
    const mf = F.monoFilter;
    const sum = mf[0] + mf[1] + mf[2] || 1;
    gl.uniform3f(u('uMonoFilter'), mf[0] / sum, mf[1] / sum, mf[2] / sum);
    gl.uniform3f(u('uLayerOffset'), ...F.layerOffset);
    gl.uniform3f(u('uLayerGamma'), ...F.layerGamma);
    const iso = Math.max(25, F.iso) / 400;
    gl.uniform1f(u('uGrain'), (F.grain / 100) * 0.5 * Math.pow(iso, 0.3));
    const long = Math.max(fw, fh);
    const cell = long * (1 / 4200 + (F.grainSize / 100) * (1 / 1100 - 1 / 4200)) * Math.pow(iso, 0.2);
    gl.uniform1f(u('uGrainCell'), Math.max(0.6, cell));
    gl.uniform1f(u('uGrainColor'), F.grainColor / 100);
    gl.uniform1f(u('uHalation'), F.halation / 100);
    gl.uniform1f(u('uBloom'), (F.bloom / 100) * 0.5);
    gl.uniform1f(u('uVignette'), F.vignette / 100);
    gl.uniform1f(u('uVignetteSize'), F.vignetteSize / 100);
    gl.uniform1f(u('uLeak'), F.leak / 100);
    gl.uniform1f(u('uLeakSeed'), F.leakSeed);
    gl.uniform1i(u('uBorder'), F.border ? 1 : 0);
  }

  // ───────────── 顯示 ─────────────

  display(view: View) {
    const gl = this.gl;
    if (this.canvas.width !== view.canvasW || this.canvas.height !== view.canvasH) {
      this.canvas.width = view.canvasW;
      this.canvas.height = view.canvasH;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, view.canvasW, view.canvasH);
    const bg = 0x12 / 255;
    if (!this.preview.out || !this.srcTex) {
      gl.clearColor(bg, bg, bg, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const p = this.p.display;
    gl.useProgram(p.prog);
    this.bindTex(0, this.preview.out.tex, p.u('uOut'));
    this.bindTex(1, this.srcTex, p.u('uSrc'));
    gl.uniform2f(p.u('uCanvas'), view.canvasW, view.canvasH);
    gl.uniform4f(p.u('uRect'), ...view.rect);
    gl.uniform1f(p.u('uSplitX'), view.splitX);
    gl.uniformMatrix3fv(p.u('uGeo'), false, mat3(this.geo));
    gl.uniform3f(p.u('uBg'), bg, bg, bg);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ───────────── 讀回 ─────────────

  private read(t: Target): Uint8Array<ArrayBuffer> {
    const gl = this.gl;
    const px = new Uint8Array(t.w * t.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  /** 縮小讀回預覽結果（直方圖、縮圖用）；第 0 列 = 影像頂端 */
  readSmall(long: number, from: 'preview' | 'side' = 'preview'): Pixels | null {
    const src = (from === 'preview' ? this.preview : this.side).out;
    if (!src) return null;
    const k = Math.min(1, long / Math.max(src.w, src.h));
    const w = Math.max(1, Math.round(src.w * k)), h = Math.max(1, Math.round(src.h * k));
    this.small = ensureTarget(this.gl, this.small, w, h, 'u8');
    this.pass(this.p.blit, this.small, (u) => this.bindTex(0, src.tex, u('uTex')));
    return { data: this.read(this.small), w, h };
  }

  histogram(): { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array } | null {
    const img = this.readSmall(320);
    if (!img) return null;
    const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      r[d[i]]++;
      g[d[i + 1]]++;
      b[d[i + 2]]++;
      l[Math.round(d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722)]++;
    }
    return { r, g, b, l };
  }

  /** 用另一份狀態在小緩衝算一張預覽（底片配方縮圖），不影響主預覽 */
  renderVariant(s: EditState, long: number): Pixels | null {
    if (!this.srcTex) return null;
    const [fw, fh] = outputSize(this.srcW, this.srcH, s.geometry);
    this.runPipeline(this.side, { scale: long / Math.max(fw, fh) }, s);
    return this.side.out ? { data: this.read(this.side.out), w: this.side.out.w, h: this.side.out.h } : null;
  }

  /** 匯出：以指定比例算全圖並讀回 RGBA（第 0 列 = 頂端） */
  renderExport(scale: number, s?: EditState): Pixels {
    const st = s ?? this.state!;
    if (s) this.setState(s);
    this.runPipeline(this.side, { scale }, st);
    const out = this.side.out!;
    const data = this.read(out);
    // 匯出完把邊緣緩衝釋放，避免大圖長期佔用顯示記憶體
    for (const k of ['dev', 'halo1', 'halo2', 'out'] as const) {
      const t = this.side[k];
      if (t && t.w * t.h > 4e6) {
        this.gl.deleteTexture(t.tex);
        this.gl.deleteFramebuffer(t.fbo);
        this.side[k] = null;
      }
    }
    return { data, w: out.w, h: out.h };
  }

  get lastProcess() {
    return this.lastOpts;
  }

  // ───────────── 小工具 ─────────────

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  private pass(p: Program, target: Target, setup: (u: Program['u']) => void) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.uniform2f(p.u('uSize'), target.w, target.h);
    setup(p.u);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private blur(src: Target, tmp: Target, dst: Target, sigma: number) {
    const gl = this.gl;
    const run = (from: Target, to: Target, dir: [number, number]) =>
      this.pass(this.p.blur, to, (u) => {
        this.bindTex(0, from.tex, u('uTex'));
        gl.uniform2f(u('uDir'), ...dir);
        gl.uniform1f(u('uSigma'), Math.max(0.5, sigma));
      });
    run(src, tmp, [1, 0]);
    run(tmp, dst, [0, 1]);
  }

  static get brushLong() {
    return BRUSH_LONG;
  }
}

export interface Pixels {
  data: Uint8Array<ArrayBuffer>;
  w: number;
  h: number;
}

export function toImageData(p: Pixels): ImageData {
  return new ImageData(new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.byteLength), p.w, p.h);
}
