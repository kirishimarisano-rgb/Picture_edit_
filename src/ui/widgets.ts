import { evalCurve } from '../core/curves';
import { filmCurve, shoulderRange, toeRange } from '../core/film';
import type { CurvePoint, Film } from '../core/state';
import { clamp, h, s } from './dom';
import { icons } from './icons';

// ───────────── 手風琴區段 ─────────────

export interface SectionOpts {
  title: string;
  open?: boolean;
  modified?: () => boolean;
  /** 眼睛：暫時關閉整段 */
  disabled?: { get: () => boolean; toggle: () => void };
  /** 雙擊標題重設 */
  reset?: () => void;
  action?: HTMLElement;
  key?: string;
}

const openMemory = new Map<string, boolean>();

export class Section {
  el: HTMLElement;
  body: HTMLDivElement;
  private eye: HTMLSpanElement | null = null;
  constructor(private o: SectionOpts, ...children: (Node | null)[]) {
    this.body = h('div.sec-body', ...children);
    const key = o.key ?? o.title;
    const open = openMemory.get(key) ?? o.open ?? false;
    const head = h('button.sec-head', { type: 'button', 'aria-expanded': String(open) },
      h('span.chev', { html: icons.chevron() }),
      h('h3', o.title),
      h('span.mdot', { title: '已修改' }),
      o.action ?? null,
    );
    if (o.disabled) {
      this.eye = h('span.eye', { role: 'button', title: '暫時關閉這一段（不會清除設定）', html: icons.eye() });
      this.eye.addEventListener('click', (e) => {
        e.stopPropagation();
        o.disabled!.toggle();
      });
      head.append(this.eye);
    }
    head.addEventListener('click', () => {
      const now = !this.el.classList.contains('open');
      this.el.classList.toggle('open', now);
      head.setAttribute('aria-expanded', String(now));
      openMemory.set(key, now);
    });
    if (o.reset) head.addEventListener('dblclick', (e) => { e.preventDefault(); o.reset!(); });
    head.title = o.reset ? '雙擊標題重設這一段' : '';
    this.el = h('section.sec', head, h('div.sec-wrap', this.body));
    if (open) this.el.classList.add('open');
    this.refresh();
  }
  refresh() {
    this.el.classList.toggle('modified', !!this.o.modified?.());
    const off = !!this.o.disabled?.get();
    this.el.classList.toggle('off', off);
    if (this.eye) this.eye.innerHTML = off ? icons.eyeOff() : icons.eye();
  }
}

/** 不可收合、只有標題的區段（光線、色彩…） */
export function flatSection(title: string, action: HTMLElement | null, ...children: (Node | null)[]) {
  return h('section.sec.flat', h('div.sec-flat-head', h('h3', title), action), h('div.sec-body', ...children));
}

// ───────────── 分段、開關 ─────────────

export function seg<T extends string>(items: { value: T; label: string; icon?: string; attrs?: Record<string, string> }[], get: () => T, set: (v: T) => void, cls = '') {
  const el = h('div.seg', { class: cls, role: 'radiogroup' });
  const btns = items.map((it) => {
    const b = h('button', { type: 'button', role: 'radio', ...(it.attrs ?? {}) });
    if (it.icon) b.innerHTML = it.icon;
    b.append(it.label);
    b.addEventListener('click', () => { set(it.value); refresh(); });
    el.append(b);
    return b;
  });
  const refresh = () => btns.forEach((b, i) => { const on = items[i].value === get(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  refresh();
  return { el, refresh };
}

export function toggle(label: string, get: () => boolean, set: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.addEventListener('change', () => set(input.checked));
  const el = h('label.toggle', h('span', label), input);
  const refresh = () => { input.checked = get(); };
  refresh();
  return { el, refresh };
}

// ───────────── 直方圖 ─────────────

export class Histogram {
  el: HTMLDivElement;
  private c: HTMLCanvasElement;
  private lo: HTMLDivElement;
  private hi: HTMLDivElement;
  constructor() {
    this.c = h('canvas', { width: 576, height: 168, 'aria-hidden': 'true' });
    this.lo = h('div.clip.lo', { title: '暗部截斷' });
    this.hi = h('div.clip.hi', { title: '亮部截斷' });
    this.el = h('div.histo', { role: 'img', 'aria-label': '直方圖' }, this.c, this.lo, this.hi);
  }
  draw(d: { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array } | null) {
    const ctx = this.c.getContext('2d')!;
    const W = this.c.width, H = this.c.height;
    ctx.clearRect(0, 0, W, H);
    if (!d) return;
    let total = 0;
    for (let i = 0; i < 256; i++) total += d.l[i];
    // 以第 99 百分位當頂，避免單一尖峰把其他壓扁
    const all = [...d.r, ...d.g, ...d.b].slice().sort((a, b) => a - b);
    const top = Math.max(1, all[Math.floor(all.length * 0.985)] * 1.15);
    const path = (arr: Uint32Array) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        const v = Math.sqrt(Math.min(1, arr[i] / top));
        ctx.lineTo((i / 255) * W, H - v * (H - 4));
      }
      ctx.lineTo(W, H);
      ctx.closePath();
    };
    ctx.globalCompositeOperation = 'source-over';
    path(d.l);
    ctx.fillStyle = 'rgba(150,150,150,0.2)';
    ctx.fill();
    ctx.globalCompositeOperation = 'screen';
    const cols: [Uint32Array, string][] = [[d.r, 'rgba(255,90,72,0.42)'], [d.g, 'rgba(90,200,104,0.38)'], [d.b, 'rgba(76,124,255,0.5)']];
    for (const [arr, col] of cols) { path(arr); ctx.fillStyle = col; ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';
    // 四分位格線
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo((i / 4) * W, 0); ctx.lineTo((i / 4) * W, H); ctx.stroke(); }
    const clipLo = (d.r[0] + d.g[0] + d.b[0]) / (3 * total);
    const clipHi = (d.r[255] + d.g[255] + d.b[255]) / (3 * total);
    this.lo.classList.toggle('on', clipLo > 0.004);
    this.hi.classList.toggle('on', clipHi > 0.004);
  }
}

// ───────────── 曲線編輯器 ─────────────

export class CurveEditor {
  el: HTMLDivElement;
  private svg: SVGSVGElement;
  private path: SVGPathElement;
  private pts: SVGGElement;
  private bg: SVGPathElement;
  private readout: HTMLDivElement;
  private sel = -1;
  constructor(
    private get: () => CurvePoint[],
    private set: (pts: CurvePoint[], live: boolean) => void,
    private color: () => string,
  ) {
    this.svg = s('svg', { viewBox: '0 0 256 256', preserveAspectRatio: 'none' });
    const grid = s('path', { d: 'M64 0V256M128 0V256M192 0V256M0 64H256M0 128H256M0 192H256', stroke: '#262626', 'stroke-width': 1, fill: 'none', 'vector-effect': 'non-scaling-stroke' });
    const diag = s('path', { d: 'M0 256L256 0', stroke: '#3a3a3a', 'stroke-width': 1, 'stroke-dasharray': '3 3', fill: 'none', 'vector-effect': 'non-scaling-stroke' });
    this.bg = s('path', { fill: 'rgba(255,255,255,0.06)' });
    this.path = s('path', { fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' });
    this.pts = s('g');
    this.svg.append(this.bg, grid, diag, this.path, this.pts);
    this.readout = h('div.readout');
    this.el = h('div.graph', { role: 'application', 'aria-label': '曲線：點擊加點、拖曳調整、雙擊點刪除' }, this.svg, this.readout);
    this.bind();
    this.refresh();
  }

  setHistogram(l: Uint32Array | null) {
    if (!l) return this.bg.setAttribute('d', '');
    const max = Math.max(1, ...Array.from(l).slice(1, 255));
    let d = 'M0 256';
    for (let i = 0; i < 256; i++) d += `L${i} ${256 - Math.sqrt(Math.min(1, l[i] / max)) * 230}`;
    this.bg.setAttribute('d', d + 'L256 256Z');
  }

  refresh() {
    const pts = this.get();
    const lut = evalCurve(pts, 129);
    let d = '';
    lut.forEach((y, i) => (d += `${i ? 'L' : 'M'}${(i / 128) * 256} ${256 - y * 256}`));
    this.path.setAttribute('d', d);
    this.path.setAttribute('stroke', this.color());
    this.pts.replaceChildren(...pts.map(([x, y], i) => s('circle', { class: `pt${i === this.sel ? ' sel' : ''}`, cx: x * 256, cy: 256 - y * 256, r: 4, 'vector-effect': 'non-scaling-stroke' })));
    // 讓圓點不被拉伸：外框是正方形，所以 r 固定即可
  }

  private bind() {
    const toXY = (e: PointerEvent): [number, number] => {
      const r = this.svg.getBoundingClientRect();
      return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)];
    };
    let dragging = false;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [x, y] = toXY(e);
      const pts = this.get().map((p) => [...p] as CurvePoint);
      const r = this.svg.getBoundingClientRect();
      const hit = pts.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 10);
      if (hit >= 0) this.sel = hit;
      else {
        pts.push([x, y]);
        pts.sort((a, b) => a[0] - b[0]);
        this.sel = pts.findIndex((p) => p[0] === x && p[1] === y);
        this.set(pts, true);
      }
      dragging = true;
      this.el.setPointerCapture(e.pointerId);
      this.refresh();
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!dragging || this.sel < 0) return;
      const [x, y] = toXY(e);
      const pts = this.get().map((p) => [...p] as CurvePoint);
      const i = this.sel;
      const lo = i > 0 ? pts[i - 1][0] + 0.01 : 0;
      const hi = i < pts.length - 1 ? pts[i + 1][0] - 0.01 : 1;
      pts[i] = [clamp(x, lo, hi), y];
      this.readout.textContent = `${Math.round(pts[i][0] * 255)} → ${Math.round(y * 255)}`;
      this.set(pts, true);
      this.refresh();
    });
    const up = () => {
      if (!dragging) return;
      dragging = false;
      this.readout.textContent = '';
      this.set(this.get(), false);
    };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    this.el.addEventListener('dblclick', (e) => {
      const r = this.svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
      const pts = this.get().map((p) => [...p] as CurvePoint);
      const hit = pts.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 10);
      if (hit > 0 && hit < pts.length - 1) pts.splice(hit, 1);
      else if (hit < 0) { pts.length = 0; pts.push([0, 0], [1, 1]); }
      this.sel = -1;
      this.set(pts, false);
      this.refresh();
    });
  }
}

// ───────────── 底片特性曲線圖 ─────────────

export class FilmGraph {
  el: HTMLDivElement;
  private svg: SVGSVGElement;
  private layers: SVGPathElement[];
  private main: SVGPathElement;
  private toeH: SVGCircleElement;
  private shH: SVGCircleElement;
  private readonly EV0 = -8;
  private readonly EV1 = 6;
  constructor(private get: () => Film, private set: (patch: Partial<Film>, live: boolean) => void) {
    this.svg = s('svg', { viewBox: '0 0 288 96', preserveAspectRatio: 'none' });
    const grid = s('path', { d: 'M96 0V96M192 0V96M0 32H288M0 64H288', stroke: '#262626', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    const ref = s('path', { d: 'M0 96L288 0', stroke: '#3a3a3a', 'stroke-dasharray': '3 3', 'stroke-width': 1, fill: 'none', 'vector-effect': 'non-scaling-stroke' });
    const colors = ['rgba(255,110,90,.55)', 'rgba(110,220,120,.5)', 'rgba(100,150,255,.6)'];
    this.layers = colors.map((c) => s('path', { stroke: c, 'stroke-width': 1, fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
    this.main = s('path', { stroke: 'var(--accent)', 'stroke-width': 2, fill: 'none', 'vector-effect': 'non-scaling-stroke' });
    this.svg.append(grid, ref, ...this.layers, this.main);
    // 控制點用 HTML 疊在上面，避免被 preserveAspectRatio 拉成橢圓
    this.toeH = s('circle');
    this.shH = s('circle');
    const dots = s('svg', { style: 'position:absolute;inset:0;width:100%;height:100%;overflow:visible' });
    for (const c of [this.toeH, this.shH]) { c.setAttribute('r', '5'); c.setAttribute('class', 'pt'); dots.append(c); }
    this.el = h('div.graph.wide', { role: 'img', 'aria-label': '特性曲線：拖曳左邊的點調整趾部、右邊的點調整肩部' }, this.svg, dots);
    this.bind();
    this.refresh();
  }

  private xOf(ev: number) { return ((ev - this.EV0) / (this.EV1 - this.EV0)) * 288; }
  private yOf(y: number) { const p = y <= 0 ? 0 : y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055; return 96 - p * 96; }

  refresh() {
    const f = this.get();
    const line = (off: number, g: number) => {
      let d = '';
      for (let i = 0; i <= 96; i++) {
        const ev = this.EV0 + (i / 96) * (this.EV1 - this.EV0);
        const y = filmCurve(0.18 * 2 ** ev, f, off, g);
        d += `${i ? 'L' : 'M'}${this.xOf(ev).toFixed(1)} ${this.yOf(y).toFixed(1)}`;
      }
      return d;
    };
    this.main.setAttribute('d', line(0, 1));
    const showLayers = !f.mono && (f.layerOffset.some((v) => v !== 0) || f.layerGamma.some((v) => v !== 1));
    this.layers.forEach((p, i) => p.setAttribute('d', showLayers ? line(f.layerOffset[i], f.layerGamma[i]) : ''));
    const r = this.el.getBoundingClientRect();
    const W = r.width || 288, H = r.height || 96;
    const place = (c: SVGCircleElement, ev: number) => {
      const y = filmCurve(0.18 * 2 ** ev, f);
      c.setAttribute('cx', String((this.xOf(ev) / 288) * W));
      c.setAttribute('cy', String((this.yOf(y) / 96) * H));
    };
    place(this.toeH, this.toeEv(f));
    place(this.shH, this.shEv(f));
  }

  private toeEv(f: Film) { return -toeRange(f.toe) * 0.55 - f.filmExposure; }
  private shEv(f: Film) { return shoulderRange(f.shoulder) * 0.55 - f.filmExposure; }

  private bind() {
    let which: 'toe' | 'shoulder' | null = null;
    this.el.addEventListener('pointerdown', (e) => {
      const r = this.el.getBoundingClientRect();
      const ev = this.EV0 + ((e.clientX - r.left) / r.width) * (this.EV1 - this.EV0);
      const f = this.get();
      which = Math.abs(ev - this.toeEv(f)) < Math.abs(ev - this.shEv(f)) ? 'toe' : 'shoulder';
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!which) return;
      const r = this.el.getBoundingClientRect();
      const f = this.get();
      const ev = this.EV0 + ((e.clientX - r.left) / r.width) * (this.EV1 - this.EV0) + f.filmExposure;
      if (which === 'toe') {
        const range = clamp(-ev / 0.55, 2.5, 8);
        this.set({ toe: Math.round(((8 - range) / 5.5) * 100) }, true);
      } else {
        const range = clamp(ev / 0.55, 2.47, 4.5);
        this.set({ shoulder: Math.round(((4.5 - range) / (4.5 - 2.474)) * 100) }, true);
      }
      this.refresh();
    });
    const up = () => { if (which) { which = null; this.set({}, false); } };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    new ResizeObserver(() => this.refresh()).observe(this.el);
  }
}

// ───────────── 手機刻度尺 ─────────────

export class Ruler {
  el: HTMLDivElement;
  private c: HTMLCanvasElement;
  constructor(private o: { get: () => { v: number; min: number; max: number; step: number; def: number }; set: (v: number, live: boolean) => void }) {
    this.c = h('canvas', { 'aria-hidden': 'true' });
    this.el = h('div.ruler', this.c);
    this.bind();
    new ResizeObserver(() => this.draw()).observe(this.el);
  }
  draw() {
    const r = this.el.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.c.width = Math.max(1, r.width * dpr);
    this.c.height = Math.max(1, r.height * dpr);
    const ctx = this.c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const { v, min, max } = this.o.get();
    const span = max - min;
    const pxPer = r.width / (span * 0.5); // 一個畫面寬 = 一半的範圍
    const ticks = 40;
    const unit = span / ticks;
    for (let i = 0; i <= ticks; i++) {
      const val = min + i * unit;
      const x = r.width / 2 + (val - v) * pxPer;
      if (x < -2 || x > r.width + 2) continue;
      const big = i % 5 === 0;
      ctx.fillStyle = big ? '#8a8a8a' : '#4a4a4a';
      const hh = big ? 20 : 10;
      ctx.fillRect(Math.round(x), r.height - 8 - hh, 1, hh);
    }
  }
  private bind() {
    let sx = 0, sv = 0, active = false, lastTap = 0;
    this.el.addEventListener('pointerdown', (e) => {
      active = true; sx = e.clientX; sv = this.o.get().v;
      this.el.setPointerCapture(e.pointerId);
      const now = performance.now();
      if (now - lastTap < 300) { this.o.set(this.o.get().def, false); this.draw(); active = false; }
      lastTap = now;
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!active) return;
      const { min, max, step } = this.o.get();
      const w = this.el.getBoundingClientRect().width;
      const v = clamp(sv - ((e.clientX - sx) / w) * (max - min) * 0.5, min, max);
      this.o.set(Math.round(v / step) * step, true);
      this.draw();
    });
    const up = () => { if (active) { active = false; this.o.set(this.o.get().v, false); } };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }
}
