import { clamp, h, signed } from './dom';

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step?: number;
  /** 歸零值 */
  def?: number;
  /** 顯示格式 */
  format?: (v: number) => string;
  /** 功能性軌道（色溫、色相…） */
  track?: string;
  get: () => number;
  /** live = 拖動中；false = 放開（寫入歷史） */
  set: (v: number, live: boolean) => void;
  /** 數值輸入時的換算（例如百分比） */
  parse?: (s: string) => number;
}

/**
 * 滑桿：雙擊歸零、拖動時浮出數值、Shift 微調、方向鍵與滾輪、點數值直接輸入。
 */
export class Slider {
  el: HTMLDivElement;
  private val: HTMLButtonElement;
  private track: HTMLDivElement;
  private fill: HTMLDivElement;
  private thumb: HTMLDivElement;
  private bubble: HTMLSpanElement;
  private o: Required<Omit<SliderOpts, 'track' | 'parse'>> & Pick<SliderOpts, 'track' | 'parse'>;
  private v = 0;

  constructor(opts: SliderOpts) {
    const step = opts.step ?? 1;
    this.o = {
      ...opts,
      step,
      def: opts.def ?? 0,
      format: opts.format ?? ((v) => (opts.min < 0 ? signed(v, step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0) : String(Math.round(v)))),
    };
    const bipolar = opts.min < 0 && opts.max > 0;
    this.val = h('button.sl-val', { type: 'button', title: '點一下輸入數值', tabindex: '-1' });
    this.fill = h('div.sl-fill');
    this.bubble = h('span.sl-bubble');
    this.thumb = h('div.sl-thumb', this.bubble);
    this.track = h('div.sl-track', {
      role: 'slider',
      tabindex: '0',
      'aria-label': opts.label,
      'aria-valuemin': opts.min,
      'aria-valuemax': opts.max,
    }, h('div.sl-rail', opts.track ? { style: `background:${opts.track}` } : {}), bipolar ? h('div.sl-zero') : null, this.fill, this.thumb);
    if (opts.track) this.track.classList.add('functional');
    this.el = h('div.sl', h('div.sl-row', h('span.sl-label', opts.label), this.val), this.track);
    this.bind();
    this.refresh();
  }

  private pct(v: number) {
    return ((v - this.o.min) / (this.o.max - this.o.min)) * 100;
  }

  private quantize(v: number) {
    const s = this.o.step;
    return clamp(Math.round(v / s) * s, this.o.min, this.o.max);
  }

  private show(v: number) {
    this.v = v;
    const p = this.pct(v);
    const z = this.pct(clamp(this.o.def, this.o.min, this.o.max));
    const bip = this.o.min < 0 && this.o.max > 0;
    const a = bip ? Math.min(p, z) : 0, b = bip ? Math.max(p, z) : p;
    this.fill.style.left = `${a}%`;
    this.fill.style.width = `${b - a}%`;
    this.thumb.style.left = `${p}%`;
    const txt = this.o.format(v);
    this.val.textContent = txt;
    this.bubble.textContent = txt;
    const modified = Math.abs(v - this.o.def) > 1e-9;
    this.el.classList.toggle('modified', modified);
    this.track.setAttribute('aria-valuenow', String(+v.toFixed(4)));
    this.track.setAttribute('aria-valuetext', txt);
  }

  refresh() {
    this.show(this.o.get());
  }

  private emit(v: number, live: boolean) {
    const q = this.quantize(v);
    this.show(q);
    this.o.set(q, live);
  }

  private bind() {
    let startX = 0, startV = 0, dragging = false, moved = false;
    const width = () => this.track.getBoundingClientRect().width || 1;
    const fromX = (x: number) => {
      const r = this.track.getBoundingClientRect();
      return this.o.min + clamp((x - r.left) / r.width, 0, 1) * (this.o.max - this.o.min);
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.track.focus({ preventScroll: true });
      this.track.setPointerCapture(e.pointerId);
      dragging = true;
      moved = false;
      startX = e.clientX;
      const onThumb = e.target === this.thumb || this.thumb.contains(e.target as Node);
      if (!onThumb && e.pointerType !== 'touch') this.emit(fromX(e.clientX), true);
      startV = this.v;
      this.el.classList.add('dragging');
    });
    this.track.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 1) moved = true;
      const k = e.shiftKey ? 0.1 : 1;
      this.emit(startV + (dx / width()) * (this.o.max - this.o.min) * k, true);
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('dragging');
      if (this.track.hasPointerCapture(e.pointerId)) this.track.releasePointerCapture(e.pointerId);
      this.o.set(this.v, false);
      void moved;
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    this.el.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      this.emit(this.o.def, false);
    });
    this.track.addEventListener('keydown', (e) => {
      const big = e.shiftKey ? 10 : 1;
      let d = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = this.o.step * big;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -this.o.step * big;
      else if (e.key === 'Home') return this.emit(this.o.min, false);
      else if (e.key === 'End') return this.emit(this.o.max, false);
      else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') return this.emit(this.o.def, false);
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.emit(this.v + d, false);
    });
    this.track.addEventListener('wheel', (e) => {
      if (document.activeElement !== this.track) return;
      e.preventDefault();
      this.emit(this.v + (e.deltaY < 0 ? 1 : -1) * this.o.step * (e.shiftKey ? 10 : 1), false);
    }, { passive: false });
    this.val.addEventListener('click', () => this.edit());
  }

  private edit() {
    const input = h('input.sl-input', { type: 'text', value: String(+this.v.toFixed(4)), 'aria-label': this.o.label });
    this.val.replaceWith(input);
    input.select();
    const done = (apply: boolean) => {
      if (!input.isConnected) return;
      input.replaceWith(this.val);
      if (!apply) return;
      const raw = input.value.replace('−', '-').replace('+', '');
      const n = this.o.parse ? this.o.parse(raw) : parseFloat(raw);
      if (Number.isFinite(n)) this.emit(n, false);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }
}
