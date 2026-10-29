import { apply, invert, type Affine } from '../core/geometry';
import { clamp, h, s } from './dom';

export interface Overlay {
  /** 每次重畫時更新疊加層 */
  render(g: SVGGElement, vp: Viewport): void;
  /** 回傳 true 表示這個事件由工具處理（不平移） */
  down?(e: PointerEvent, p: [number, number]): boolean;
  move?(e: PointerEvent, p: [number, number]): void;
  up?(e: PointerEvent, p: [number, number]): void;
  hover?(p: [number, number] | null): void;
  cls?: string;
}

/**
 * 檢視區：負責縮放平移、座標換算、觸控手勢、前後對比分割線，以及工具疊加層的事件轉發。
 */
export class Viewport {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  svg: SVGSVGElement;
  private g: SVGGElement;
  private splitEl: HTMLDivElement;
  private labels: [HTMLDivElement, HTMLDivElement];
  hint: HTMLDivElement;
  zoom: 'fit' | number = 'fit';
  /** 檢視中心（輸出 uv） */
  center: [number, number] = [0.5, 0.5];
  /** 分割線位置（0..1，相對檢視區寬）；null = 關閉 */
  split: number | null = null;
  /** 整張顯示原圖（按住 \） */
  showBefore = false;
  outW = 1;
  outH = 1;
  /** css px：照片在檢視區的位置 */
  rect: [number, number, number, number] = [0, 0, 1, 1];
  geo: Affine = [1, 0, 0, 0, 1, 0];
  private geoInv: Affine = [1, 0, 0, 0, 1, 0];
  overlay: Overlay | null = null;
  spaceDown = false;
  private pointers = new Map<number, [number, number]>();
  private pan: { x: number; y: number; c: [number, number] } | null = null;
  private pinch: { d: number; z: number; mid: [number, number]; c: [number, number] } | null = null;
  private toolActive = false;
  padding = 32;

  constructor(private onChange: (reason: 'view' | 'zoom') => void) {
    this.canvas = h('canvas');
    this.svg = s('svg', { class: 'overlay' });
    this.g = s('g');
    this.svg.append(this.g);
    this.splitEl = h('div.split-handle', { role: 'slider', 'aria-label': '前後對比分割線', tabindex: '0' }, h('div.knob', { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l-6 6 6 6M15 6l6 6-6 6"/></svg>' }));
    this.labels = [h('div.vp-label', { style: 'left:12px' }, '修改前'), h('div.vp-label', { style: 'right:12px' }, '修改後')];
    this.hint = h('div.vp-hint');
    this.hint.style.opacity = '0';
    this.el = h('div.viewport', this.canvas, this.svg, this.splitEl, ...this.labels, this.hint);
    this.bind();
    new ResizeObserver(() => this.onChange('view')).observe(this.el);
  }

  get dpr() {
    return Math.min(3, window.devicePixelRatio || 1);
  }
  get width() {
    return this.el.clientWidth;
  }
  get height() {
    return this.el.clientHeight;
  }

  fitScale() {
    const pad = this.padding;
    return Math.min((this.width - pad * 2) / this.outW, (this.height - pad * 2) / this.outH);
  }

  /** 每 css px 對應幾個輸出像素的倒數：螢幕 css px / 輸出像素 */
  get scale() {
    return this.zoom === 'fit' ? this.fitScale() : this.zoom;
  }

  setOutput(w: number, h: number, geo: Affine) {
    this.outW = w;
    this.outH = h;
    this.geo = geo;
    this.geoInv = invert(geo);
  }

  layout(): [number, number, number, number] {
    const sc = this.scale;
    const w = this.outW * sc, hh = this.outH * sc;
    let x: number, y: number;
    if (this.zoom === 'fit') {
      x = (this.width - w) / 2;
      y = (this.height - hh) / 2;
    } else {
      // 照片比畫面小的方向就置中，否則依中心點
      x = w <= this.width ? (this.width - w) / 2 : this.width / 2 - this.center[0] * w;
      y = hh <= this.height ? (this.height - hh) / 2 : this.height / 2 - this.center[1] * hh;
      x = w <= this.width ? x : clamp(x, this.width - w, 0);
      y = hh <= this.height ? y : clamp(y, this.height - hh, 0);
    }
    this.rect = [x, y, w, hh];
    this.updateChrome();
    return this.rect;
  }

  /** 前後對比：分割點（css px），-1 = 不分割 */
  splitX(): number {
    if (this.showBefore) return 1e9;
    if (this.split === null) return -1;
    return this.split * this.width;
  }

  private updateChrome() {
    const on = this.split !== null && !this.showBefore;
    this.splitEl.style.display = on ? 'flex' : 'none';
    if (on) this.splitEl.style.left = `${this.split! * this.width}px`;
    this.labels[0].style.opacity = on || this.showBefore ? '1' : '0';
    this.labels[1].style.opacity = on ? '1' : '0';
    const [x, y] = this.rect;
    this.labels[0].style.top = this.labels[1].style.top = `${Math.max(12, y + 12)}px`;
    this.labels[0].style.left = `${Math.max(12, x + 12)}px`;
    this.labels[1].style.right = `${Math.max(12, this.width - (x + this.rect[2]) + 12)}px`;
  }

  outToScreen(u: number, v: number): [number, number] {
    return [this.rect[0] + u * this.rect[2], this.rect[1] + v * this.rect[3]];
  }
  screenToOut(x: number, y: number): [number, number] {
    return [(x - this.rect[0]) / this.rect[2], (y - this.rect[1]) / this.rect[3]];
  }
  srcToScreen(u: number, v: number): [number, number] {
    const [ou, ov] = apply(this.geoInv, u, v);
    return this.outToScreen(ou, ov);
  }
  screenToSrc(x: number, y: number): [number, number] {
    const [u, v] = this.screenToOut(x, y);
    return apply(this.geo, u, v);
  }
  /** 來源 uv → 螢幕的仿射矩陣（給 SVG transform 用） */
  srcToScreenMatrix(): Affine {
    const [rx, ry, rw, rh] = this.rect;
    const gi = this.geoInv;
    return [rw * gi[0], rw * gi[1], rw * gi[2] + rx, rh * gi[3], rh * gi[4], rh * gi[5] + ry];
  }

  renderOverlay() {
    this.g.replaceChildren();
    this.overlay?.render(this.g, this);
    const cls = this.overlay?.cls ?? '';
    if (cls !== this.lastCls) {
      if (this.lastCls) this.el.classList.remove(...this.lastCls.split(' '));
      if (cls) this.el.classList.add(...cls.split(' '));
      this.lastCls = cls;
    }
    this.el.classList.toggle('can-pan', this.canPan());
  }
  private lastCls = '';

  private canPan() {
    if (this.zoom === 'fit') return false;
    return this.outW * this.scale > this.width + 1 || this.outH * this.scale > this.height + 1;
  }

  setZoom(z: 'fit' | number, anchor?: [number, number]) {
    const fit = this.fitScale();
    if (z !== 'fit') {
      z = clamp(z, Math.min(fit, 0.05), 16);
      if (Math.abs(z - fit) / fit < 0.02 && anchor === undefined) z = 'fit';
    }
    if (z !== 'fit' && anchor) {
      const [u, v] = this.screenToOut(anchor[0], anchor[1]);
      const sc = z as number;
      // 讓 anchor 下的點保持不動
      const cx = u - (anchor[0] - this.width / 2) / (this.outW * sc);
      const cy = v - (anchor[1] - this.height / 2) / (this.outH * sc);
      this.center = [cx, cy];
    } else if (z !== 'fit' && this.zoom === 'fit') {
      this.center = [0.5, 0.5];
    }
    this.zoom = z;
    this.onChange('zoom');
  }

  toggleOneToOne(anchor?: [number, number]) {
    if (this.zoom === 'fit' || Math.abs((this.zoom as number) - 1 / this.dpr) > 1e-3) this.setZoom(1 / this.dpr, anchor);
    else this.setZoom('fit');
  }

  private bind() {
    const local = (e: { clientX: number; clientY: number }): [number, number] => {
      const r = this.el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 && this.zoom !== 'fit') {
        // 觸控板兩指平移
        this.center = [this.center[0] + e.deltaX / (this.outW * this.scale), this.center[1] + e.deltaY / (this.outH * this.scale)];
        this.onChange('view');
        return;
      }
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022));
      this.setZoom(this.scale * k, p);
    }, { passive: false });

    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.splitEl || this.splitEl.contains(e.target as Node)) return;
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      this.el.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        // 雙指：取消工具動作，改為縮放
        if (this.toolActive) { this.overlay?.up?.(e, p); this.toolActive = false; }
        const [a, b] = [...this.pointers.values()];
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: this.scale, mid, c: this.screenToOut(mid[0], mid[1]) };
        this.pan = null;
        return;
      }
      const wantsPan = e.button === 1 || this.spaceDown || (e.button === 0 && !this.overlay?.down);
      if (!wantsPan && e.button === 0 && this.overlay?.down?.(e, p)) {
        this.toolActive = true;
        return;
      }
      if (this.canPan() || wantsPan) {
        this.pan = { x: p[0], y: p[1], c: [...this.center] as [number, number] };
        if (this.zoom === 'fit') { this.pan = null; return; }
        this.el.classList.add('panning');
      }
    });

    this.el.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const z = clamp(this.pinch.z * (d / this.pinch.d), Math.min(this.fitScale(), 0.05), 16);
        this.zoom = z;
        this.center = [this.pinch.c[0] - (mid[0] - this.width / 2) / (this.outW * z), this.pinch.c[1] - (mid[1] - this.height / 2) / (this.outH * z)];
        this.onChange('zoom');
        return;
      }
      if (this.toolActive) { this.overlay?.move?.(e, p); return; }
      if (this.pan) {
        const sc = this.scale;
        this.center = [this.pan.c[0] - (p[0] - this.pan.x) / (this.outW * sc), this.pan.c[1] - (p[1] - this.pan.y) / (this.outH * sc)];
        this.onChange('view');
        return;
      }
      this.overlay?.hover?.(p);
    });

    const end = (e: PointerEvent) => {
      const p = local(e);
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) {
          this.pinch = null;
          if (this.fitScale() >= this.scale) this.setZoom('fit');
        }
        return;
      }
      if (this.toolActive) { this.toolActive = false; this.overlay?.up?.(e, p); }
      this.pan = null;
      this.el.classList.remove('panning');
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('pointerleave', () => this.overlay?.hover?.(null));
    this.el.addEventListener('dblclick', (e) => {
      if (this.overlay?.down && !this.spaceDown) return;
      this.toggleOneToOne(local(e));
    });

    // 分割線
    let splitting = false;
    this.splitEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      splitting = true;
      this.splitEl.setPointerCapture(e.pointerId);
    });
    this.splitEl.addEventListener('pointermove', (e) => {
      if (!splitting) return;
      this.split = clamp(local(e)[0] / this.width, 0.02, 0.98);
      this.onChange('view');
    });
    this.splitEl.addEventListener('pointerup', () => (splitting = false));
    this.splitEl.addEventListener('keydown', (e) => {
      if (this.split === null) return;
      if (e.key === 'ArrowLeft') this.split = clamp(this.split - 0.02, 0.02, 0.98);
      else if (e.key === 'ArrowRight') this.split = clamp(this.split + 0.02, 0.02, 0.98);
      else return;
      e.preventDefault();
      this.onChange('view');
    });
  }

  setHint(html: string | null) {
    if (html) this.hint.innerHTML = html;
    this.hint.style.opacity = html ? '1' : '0';
  }
}
