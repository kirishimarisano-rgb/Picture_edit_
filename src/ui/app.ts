import { outputSize, outputToSource } from '../core/geometry';
import { Renderer, toImageData } from '../core/gl/renderer';
import { History } from '../core/history';
import { exifLine, type Exif } from '../core/exif';
import { applyLook, clone, defaultState, extractLook, sectionModified, uid, type EditState, type LookSettings } from '../core/state';
import { Analysis } from '../core/worker-client';
import { h } from './dom';
import { icons } from './icons';
import { Histogram } from './widgets';
import { Viewport, type Overlay } from './viewport';
import { exportDialog, shortcutsDialog, toast } from './dialogs';
import { adjustPane } from './panels/adjust';
import { filmPane } from './panels/film';
import { cropPane } from './panels/crop';
import { maskPane } from './panels/masks';
import { healPane } from './panels/heal';
import { presetsPane } from './panels/presets';
import { historyPane } from './panels/history';

export type Tool = 'adjust' | 'crop' | 'mask' | 'heal' | 'film' | 'presets' | 'history';

export interface Pane {
  el: HTMLElement;
  foot?: HTMLElement[];
  refresh(live?: boolean): void;
  overlay?: Overlay;
  show?(): void;
  hide?(): void;
  /** 手機抽屜收合時顯示的精簡版（例如膠囊＋刻度尺） */
  quick?: HTMLElement;
}

export interface Doc {
  id: string;
  name: string;
  w: number;
  h: number;
  exif: Exif;
  bitmap: ImageBitmap;
  thumb: ImageBitmap;
  state: EditState;
  history: History;
  snapshots: { id: string; name: string; state: EditState; time: number }[];
  thumbCanvas: HTMLCanvasElement;
  thumbEl: HTMLButtonElement;
}

const TOOLS: { id: Tool; label: string; key: string; icon: (s?: number) => string; mobile?: boolean }[] = [
  { id: 'adjust', label: '調整', key: 'A', icon: icons.adjust, mobile: true },
  { id: 'crop', label: '裁切與拉直', key: 'R', icon: icons.crop, mobile: true },
  { id: 'mask', label: '局部遮罩', key: 'M', icon: icons.mask, mobile: true },
  { id: 'heal', label: '修補', key: 'J', icon: icons.heal, mobile: true },
  { id: 'film', label: '底片模擬', key: 'N', icon: icons.film, mobile: true },
  { id: 'presets', label: '預設集與快照', key: 'P', icon: icons.presets, mobile: true },
];

export class App {
  root: HTMLElement;
  renderer: Renderer;
  analysis = new Analysis();
  vp: Viewport;
  docs: Doc[] = [];
  doc: Doc | null = null;
  selected = new Set<string>();
  tool: Tool = 'adjust';
  maskSel = -1;
  showMaskHeld = false;
  clipboard: LookSettings | null = null;
  histogram = new Histogram();
  lastHisto: ReturnType<Renderer['histogram']> = null;
  private panes: Partial<Record<Tool, Pane>> = {};
  private stateDirty = true;
  private raf = 0;
  private lastProc = '';
  private histoTimer = 0;
  private thumbTimer = 0;
  private ui!: {
    file: HTMLElement; zoom: HTMLElement; undo: HTMLButtonElement; redo: HTMLButtonElement; split: HTMLButtonElement;
    rail: Map<Tool, HTMLButtonElement>; mnav: Map<Tool, HTMLButtonElement>; body: HTMLElement; foot: HTMLElement; exif: HTMLElement;
    panel: HTMLElement; quick: HTMLElement; strip: HTMLElement; stripList: HTMLElement; empty: HTMLElement; exportBtn: HTMLButtonElement;
    stripApply: HTMLButtonElement;
  };
  private fileInput: HTMLInputElement;
  private tip = h('div.tip');
  private histoListeners = new Set<() => void>();

  constructor(root: HTMLElement) {
    this.root = root;
    this.vp = new Viewport((reason) => this.onView(reason));
    const glCanvas = this.vp.canvas;
    this.renderer = new Renderer(glCanvas);
    this.fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif', multiple: true, hidden: true });
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files?.length) void this.openFiles([...this.fileInput.files]);
      this.fileInput.value = '';
    });
    this.build();
    this.bindKeys();
    this.bindDrop();
    this.setTool('adjust');
    this.refreshChrome();
    this.request();
  }

  // ───────────── 狀態 ─────────────

  get state(): EditState {
    return this.doc?.state ?? defaultState();
  }

  /** 修改目前照片的編輯紀錄。live = 拖動中（不進歷史） */
  update(fn: (s: EditState) => void, label: string, live = false) {
    if (!this.doc) return;
    fn(this.doc.state);
    if (!live) this.pushHistory(label);
    this.stateChanged(live);
  }

  /** 整份換掉（復原、預設集、貼上…） */
  replaceState(s: EditState, label: string | null) {
    if (!this.doc) return;
    this.doc.state = clone(s);
    if (label) this.pushHistory(label);
    this.stateChanged(false);
  }

  private pushHistory(label: string) {
    const hst = this.doc!.history;
    const top = hst.entries[hst.index];
    if (top && top.label === label && Date.now() - top.time < 1500) hst.replaceTop(label, this.doc!.state);
    else hst.push(label, this.doc!.state);
  }

  stateChanged(live: boolean) {
    this.stateDirty = true;
    this.request();
    this.currentPane()?.refresh(live);
    this.refreshChrome();
    if (!live) this.scheduleThumb();
  }

  undo() {
    const s = this.doc?.history.undo();
    if (s) { this.doc!.state = s; this.stateChanged(false); }
  }
  redo() {
    const s = this.doc?.history.redo();
    if (s) { this.doc!.state = s; this.stateChanged(false); }
  }
  jumpHistory(i: number) {
    if (!this.doc) return;
    this.doc.state = this.doc.history.jump(i);
    this.stateChanged(false);
  }

  // ───────────── 渲染 ─────────────

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private onView(reason: 'view' | 'zoom') {
    void reason;
    this.request();
  }

  get cropMode() {
    return this.tool === 'crop';
  }

  get showMaskIndex() {
    return this.tool === 'mask' && this.showMaskHeld ? this.maskSel : -1;
  }

  private frame() {
    this.raf = 0;
    const vp = this.vp;
    const dpr = vp.dpr;
    const cw = Math.max(1, Math.round(vp.width * dpr)), ch = Math.max(1, Math.round(vp.height * dpr));
    if (!this.doc) {
      this.renderer.display({ canvasW: cw, canvasH: ch, rect: [0, 0, 0, 0], splitX: -1 });
      vp.renderOverlay();
      return;
    }
    const s = this.doc.state;
    const r = this.renderer;
    const crop = this.cropMode;
    const [ow, oh] = outputSize(r.srcW, r.srcH, s.geometry, crop);
    vp.setOutput(ow, oh, outputToSource(r.srcW, r.srcH, s.geometry, crop));
    const rect = vp.layout();
    // 工作解析度：剛好夠螢幕用，取 2^(k/3) 的級距避免縮放時一直重配置
    const need = Math.min(1, vp.scale * dpr);
    const scale = Math.min(1, 2 ** (Math.ceil(Math.log2(Math.max(need, 1 / 64)) * 3) / 3));
    const key = `${scale.toFixed(4)}|${crop}|${this.showMaskIndex}`;
    if (this.stateDirty || key !== this.lastProc) {
      if (this.stateDirty) r.setState(s);
      r.process({ scale, ignoreCrop: crop, showMask: this.showMaskIndex });
      this.stateDirty = false;
      this.lastProc = key;
      this.scheduleHisto();
    }
    const split = vp.splitX();
    r.display({
      canvasW: cw,
      canvasH: ch,
      rect: [rect[0] * dpr, rect[1] * dpr, rect[2] * dpr, rect[3] * dpr],
      splitX: split < 0 ? -1 : split * dpr,
    });
    vp.renderOverlay();
    const pct = Math.round(vp.scale * dpr * (ow / Math.max(1, ow)) * 100);
    this.ui.zoom.innerHTML = vp.zoom === 'fit' ? `適合畫面 · <b>${pct}%</b>` : `<b>${pct}%</b>`;
  }

  private scheduleHisto() {
    clearTimeout(this.histoTimer);
    this.histoTimer = window.setTimeout(() => {
      this.lastHisto = this.renderer.histogram();
      this.histogram.draw(this.lastHisto);
      this.histoListeners.forEach((f) => f());
    }, 90);
  }

  onHistogram(f: () => void) {
    this.histoListeners.add(f);
  }

  private scheduleThumb() {
    clearTimeout(this.thumbTimer);
    const doc = this.doc;
    this.thumbTimer = window.setTimeout(() => {
      if (!doc || doc !== this.doc) return;
      const img = this.renderer.renderVariant(doc.state, 240);
      if (!img) return;
      const c = doc.thumbCanvas;
      c.width = img.w;
      c.height = img.h;
      c.getContext('2d')!.putImageData(toImageData(img), 0, 0);
      this.refreshStrip();
    }, 500);
  }

  // ───────────── 照片 ─────────────

  openPicker() {
    this.fileInput.click();
  }

  async openFiles(files: File[]) {
    const imgs = files.filter((f) => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    if (!imgs.length) return toast('沒有可以開啟的照片（支援 JPEG、PNG、WebP，HEIC 視瀏覽器而定）', true);
    let first: Doc | null = null;
    for (const f of imgs) {
      const id = uid();
      try {
        const d = await this.analysis.decode(id, f, this.renderer.maxSize);
        const thumbCanvas = h('canvas', { width: d.thumb.width, height: d.thumb.height });
        thumbCanvas.getContext('2d')!.drawImage(d.thumb, 0, 0);
        const doc: Doc = {
          id, name: f.name, w: d.w, h: d.h, exif: d.exif, bitmap: d.bitmap, thumb: d.thumb,
          state: defaultState(), history: new History(defaultState()), snapshots: [],
          thumbCanvas, thumbEl: h('button.thumb', { type: 'button', title: f.name }),
        };
        this.docs.push(doc);
        if (!first) first = doc;
        this.refreshStrip();
      } catch (err) {
        toast(`${f.name}：${(err as Error).message}`, true);
      }
    }
    if (first) this.activate(first);
  }

  async openSample() {
    try {
      const res = await fetch('./samples/yosemite.jpg');
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      await this.openFiles([new File([blob], 'yosemite.jpg', { type: 'image/jpeg' })]);
    } catch {
      toast('範例照片載入失敗（單檔版本沒有附範例照片）', true);
    }
  }

  activate(doc: Doc) {
    if (this.doc === doc) return;
    this.doc = doc;
    this.selected = new Set([doc.id]);
    this.renderer.loadSource(doc.bitmap, doc.w, doc.h);
    this.maskSel = doc.state.masks.length ? 0 : -1;
    this.stateDirty = true;
    this.vp.zoom = 'fit';
    this.vp.el.classList.remove('fade');
    void this.vp.el.offsetWidth;
    this.vp.el.classList.add('fade');
    this.ui.empty.hidden = true;
    for (const p of Object.values(this.panes)) p?.refresh();
    this.currentPane()?.show?.();
    this.refreshChrome();
    this.refreshStrip();
    this.request();
  }

  closeDoc(doc: Doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    void this.analysis.release(doc.id);
    doc.bitmap.close();
    if (this.doc === doc) {
      this.doc = null;
      const next = this.docs[Math.min(i, this.docs.length - 1)];
      if (next) this.activate(next);
      else { this.ui.empty.hidden = false; this.refreshChrome(); this.request(); }
    }
    this.refreshStrip();
  }

  // ───────────── 工具 ─────────────

  currentPane(): Pane | undefined {
    return this.panes[this.tool];
  }

  pane(t: Tool): Pane {
    if (!this.panes[t]) {
      const make = { adjust: adjustPane, crop: cropPane, mask: maskPane, heal: healPane, film: filmPane, presets: presetsPane, history: historyPane }[t];
      this.panes[t] = make(this);
    }
    return this.panes[t]!;
  }

  setTool(t: Tool) {
    const prev = this.currentPane();
    if (prev && this.tool !== t) prev.hide?.();
    if (this.tool === 'crop' && t !== 'crop' && this.doc) this.pushHistory('裁切');
    this.tool = t;
    const p = this.pane(t);
    this.ui.body.replaceChildren(p.el);
    p.el.classList.add('pane');
    this.ui.foot.replaceChildren(...(p.foot ?? []));
    this.ui.quick.replaceChildren(...(p.quick ? [p.quick] : []));
    this.ui.panel.classList.toggle('has-quick', !!p.quick);
    this.ui.body.scrollTop = 0;
    this.vp.overlay = p.overlay ?? null;
    for (const [id, b] of this.ui.rail) { b.classList.toggle('on', id === t); b.setAttribute('aria-pressed', String(id === t)); }
    for (const [id, b] of this.ui.mnav) b.classList.toggle('on', id === t);
    p.refresh();
    p.show?.();
    this.vp.setZoom('fit');
    this.request();
  }

  // ───────────── 介面 ─────────────

  private build() {
    const undo = h('button.ib', { type: 'button', 'aria-label': '復原', html: icons.undo() });
    const redo = h('button.ib', { type: 'button', 'aria-label': '重做', html: icons.redo() });
    undo.addEventListener('click', () => this.undo());
    redo.addEventListener('click', () => this.redo());
    this.tipFor(undo, '復原', 'Ctrl Z');
    this.tipFor(redo, '重做', 'Ctrl ⇧ Z');
    const split = h('button.btn.desktop-only', { type: 'button', 'aria-pressed': 'false', html: icons.split() + '<span>前後對比</span>' });
    split.addEventListener('click', () => this.toggleSplit());
    this.tipFor(split, '拖曳分割線比較；按住 \\ 看原圖', 'Y');
    const splitM = h('button.ib.mobile-only', { type: 'button', 'aria-label': '按住看修改前', html: icons.split(20) });
    splitM.addEventListener('pointerdown', () => { this.vp.showBefore = true; this.request(); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) splitM.addEventListener(ev, () => { this.vp.showBefore = false; this.request(); });
    const full = h('button.ib.desktop-only', { type: 'button', 'aria-label': '全螢幕檢視', html: icons.fullscreen() });
    full.addEventListener('click', () => this.toggleChrome());
    this.tipFor(full, '全螢幕檢視', 'F');
    const exportBtn = h('button.btn.primary', { type: 'button' }, '匯出');
    exportBtn.addEventListener('click', () => this.openExport());
    this.tipFor(exportBtn, '匯出', 'Ctrl E');
    const back = h('button.ib.mobile-only', { type: 'button', 'aria-label': '開啟其他照片', html: icons.back() });
    back.addEventListener('click', () => this.openPicker());
    const zoom = h('div.zoominfo');
    const file = h('div.fileinfo');
    const topbar = h('header.topbar',
      back,
      h('div.brand', { html: icons.logo() + '<span>Picture Edit</span>' }),
      file,
      h('div.spacer.desktop-only'),
      zoom,
      h('div.desktop-only', { style: 'display:flex;gap:2px' }, undo, redo),
      split, splitM, full, exportBtn,
    );

    // 左側工具軌
    const rail = h('nav.rail', { 'aria-label': '工具' });
    const railMap = new Map<Tool, HTMLButtonElement>();
    for (const t of TOOLS) {
      const b = h('button.tool', { type: 'button', 'aria-label': t.label, html: t.icon() + '<span class="dot"></span>' });
      b.addEventListener('click', () => this.setTool(t.id));
      this.tipFor(b, t.label, t.key, 'right');
      rail.append(b);
      railMap.set(t.id, b);
    }
    rail.append(h('div', { style: 'flex:1' }));
    const hist = h('button.tool', { type: 'button', 'aria-label': '歷史紀錄', html: icons.history() });
    hist.addEventListener('click', () => this.setTool('history'));
    this.tipFor(hist, '歷史紀錄', 'H', 'right');
    railMap.set('history', hist);
    const keys = h('button.tool', { type: 'button', 'aria-label': '快捷鍵', html: icons.keyboard() });
    keys.addEventListener('click', () => shortcutsDialog());
    this.tipFor(keys, '快捷鍵', '?', 'right');
    rail.append(hist, keys);

    // 舞台
    const empty = h('div.empty', h('div.empty-box',
      h('div', { html: icons.image(32), style: 'color:#6b6b6b' }),
      h('h1', '把照片拖進來開始'),
      h('p', '所有處理都在這台電腦的瀏覽器裡完成，照片不會上傳到任何地方。'),
      h('div.btn-row',
        h('button.btn.primary', { type: 'button', on: { click: () => this.openPicker() } }, '選擇照片'),
        h('button.btn', { type: 'button', on: { click: () => void this.openSample() } }, '試用範例照片'),
      ),
      h('div.fine', 'JPEG · PNG · WebP · HEIC（Safari）　可一次開多張'),
    ));
    this.vp.el.append(empty, h('div.drop-veil', '放開以加入照片'));
    const stripList = h('div', { style: 'display:flex;gap:8px;align-items:center' });
    const addBtn = h('button.strip-add', { type: 'button', 'aria-label': '加入照片', html: icons.plus(18) });
    addBtn.addEventListener('click', () => this.openPicker());
    const stripApply = h('button.btn.sm', { type: 'button' }, '同步設定到選取');
    stripApply.addEventListener('click', () => this.syncToSelected());
    const batch = h('button.btn.sm', { type: 'button' }, '批次匯出');
    batch.addEventListener('click', () => this.openExport(true));
    const strip = h('div.filmstrip', { 'aria-label': '底片條' }, stripList, addBtn, h('div.strip-actions', stripApply, batch));
    const stage = h('main.stage', this.vp.el, strip);

    // 右面板
    const exif = h('div.exif');
    const quick = h('div.quick');
    const handle = h('div.drawer-handle', { role: 'button', 'aria-label': '展開或收合面板' }, h('span'));
    const body = h('div.panel-body');
    const foot = h('div.panel-foot');
    const panel = h('aside.panel', { 'aria-label': '調整面板' }, handle, h('div.panel-head', this.histogram.el, exif), quick, body, foot);
    handle.addEventListener('click', () => panel.classList.toggle('expanded'));
    let dragY: number | null = null;
    handle.addEventListener('pointerdown', (e) => { dragY = e.clientY; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointerup', (e) => {
      if (dragY !== null && Math.abs(e.clientY - dragY) > 24) panel.classList.toggle('expanded', e.clientY < dragY);
      dragY = null;
    });

    // 手機底部工具列
    const mnav = h('nav.mnav.mobile-only', { 'aria-label': '工具' });
    const mnavMap = new Map<Tool, HTMLButtonElement>();
    for (const t of TOOLS.filter((x) => x.mobile)) {
      const b = h('button', { type: 'button', html: t.icon(20) + `<span>${t.label.slice(0, 2)}</span>` });
      b.addEventListener('click', () => this.setTool(t.id));
      mnav.append(b);
      mnavMap.set(t.id, b);
    }
    panel.append(mnav);

    const bodyEl = h('div.body', rail, stage, panel);
    this.root.append(h('div.app', topbar, bodyEl), this.tip, this.fileInput);
    this.ui = { file, zoom, undo, redo, split, rail: railMap, mnav: mnavMap, body, foot, exif, panel, quick, strip, stripList, empty, exportBtn, stripApply };
  }

  tipFor(el: HTMLElement, label: string, key?: string, side: 'below' | 'right' = 'below') {
    el.addEventListener('pointerenter', (e) => {
      if ((e as PointerEvent).pointerType === 'touch') return;
      this.tip.innerHTML = '';
      this.tip.append(label);
      if (key) for (const k of key.split(' ')) this.tip.append(h('kbd', k));
      const r = el.getBoundingClientRect();
      this.tip.classList.add('show');
      const tw = this.tip.offsetWidth;
      if (side === 'right') { this.tip.style.left = `${r.right + 8}px`; this.tip.style.top = `${r.top + r.height / 2 - 12}px`; }
      else { this.tip.style.left = `${Math.min(innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2))}px`; this.tip.style.top = `${r.bottom + 8}px`; }
    });
    el.addEventListener('pointerleave', () => this.tip.classList.remove('show'));
    el.addEventListener('click', () => this.tip.classList.remove('show'));
  }

  refreshChrome() {
    const d = this.doc;
    this.ui.file.textContent = d ? `${d.name} · ${d.w} × ${d.h}` : '';
    this.ui.undo.disabled = !d?.history.canUndo;
    this.ui.redo.disabled = !d?.history.canRedo;
    this.ui.exportBtn.disabled = !d;
    this.ui.split.classList.toggle('on', this.vp.split !== null);
    this.ui.split.setAttribute('aria-pressed', String(this.vp.split !== null));
    const s = this.state;
    const mod: Partial<Record<Tool, boolean>> = {
      adjust: sectionModified(s, 'basic') || sectionModified(s, 'curves') || sectionModified(s, 'hsl') || sectionModified(s, 'split'),
      crop: s.geometry.angle !== 0 || s.geometry.rot90 !== 0 || s.geometry.flipH || s.geometry.flipV || s.geometry.crop.w < 1 || s.geometry.crop.h < 1,
      mask: s.masks.length > 0,
      heal: s.spots.length > 0,
      film: s.film.enabled,
    };
    for (const [id, b] of this.ui.rail) b.classList.toggle('modified', !!mod[id]);
    const parts = d ? exifLine(d.exif) : [];
    const cam = d ? [d.exif.make && !(d.exif.model ?? '').startsWith(d.exif.make) ? d.exif.make : '', d.exif.model].filter(Boolean).join(' ') : '';
    this.ui.exif.replaceChildren(...(parts.length ? parts.map((p) => h('span', p)) : [h('span.cam', cam || (d ? '沒有 EXIF 資訊' : ''))]));
    if (parts.length && cam) this.ui.exif.title = `${cam}${d!.exif.lens ? ' · ' + d!.exif.lens : ''}${d!.exif.date ? ' · ' + d!.exif.date : ''}`;
    this.ui.strip.hidden = this.docs.length < 2;
    this.ui.stripApply.disabled = this.selected.size < 2;
  }

  refreshStrip() {
    const list = this.ui.stripList;
    list.replaceChildren(...this.docs.map((d) => {
      const el = d.thumbEl;
      el.replaceChildren(d.thumbCanvas, h('span.check', { html: icons.check(12) }));
      const edited = d.history.entries.length > 1;
      if (edited) el.append(h('span.edited'));
      el.classList.toggle('active', d === this.doc);
      el.classList.toggle('selected', this.selected.has(d.id) && this.selected.size > 1);
      el.onclick = (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          if (this.selected.has(d.id) && d !== this.doc) this.selected.delete(d.id);
          else this.selected.add(d.id);
          this.refreshStrip();
          this.refreshChrome();
        } else this.activate(d);
      };
      el.oncontextmenu = (e) => {
        e.preventDefault();
        if (confirm(`從工作區移除「${d.name}」？（原始檔案不受影響）`)) this.closeDoc(d);
      };
      return el;
    }));
    this.refreshChrome();
  }

  toggleSplit() {
    this.vp.split = this.vp.split === null ? 0.5 : null;
    this.refreshChrome();
    this.request();
  }

  toggleChrome() {
    const app = this.root.querySelector('.app')!;
    const on = !app.classList.contains('chrome-hidden');
    app.classList.toggle('chrome-hidden', on);
    if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.vp.padding = on ? 0 : 32;
    setTimeout(() => this.vp.setZoom('fit'), 200);
  }

  togglePanel() {
    this.root.querySelector('.app')!.classList.toggle('panel-hidden');
    setTimeout(() => this.vp.setZoom('fit'), 200);
  }

  // ───────────── 設定複製 ─────────────

  copySettings() {
    if (!this.doc) return;
    this.clipboard = extractLook(this.doc.state);
    toast('已複製調整設定（不含裁切、遮罩、修補）');
  }

  pasteSettings() {
    if (!this.doc || !this.clipboard) return;
    this.replaceState(applyLook(this.doc.state, this.clipboard), '貼上設定');
    toast('已貼上設定');
  }

  syncToSelected() {
    if (!this.doc) return;
    const look = extractLook(this.doc.state);
    let n = 0;
    for (const d of this.docs) {
      if (d === this.doc || !this.selected.has(d.id)) continue;
      d.state = applyLook(d.state, look);
      d.history.push('同步設定', d.state);
      this.renderThumbFor(d);
      n++;
    }
    toast(`已把目前的調整同步到 ${n} 張照片`);
    this.refreshStrip();
  }

  applyLookTo(docs: Doc[], look: Partial<LookSettings>, label: string) {
    for (const d of docs) {
      d.state = applyLook(d.state, look);
      d.history.push(label, d.state);
      if (d === this.doc) this.stateChanged(false);
      else this.renderThumbFor(d);
    }
    this.refreshStrip();
  }

  /** 非目前照片的縮圖：暫時換來源算一張再換回來 */
  private renderThumbFor(d: Doc) {
    const cur = this.doc;
    this.renderer.loadSource(d.bitmap, d.w, d.h);
    const img = this.renderer.renderVariant(d.state, 240);
    if (img) {
      d.thumbCanvas.width = img.w;
      d.thumbCanvas.height = img.h;
      d.thumbCanvas.getContext('2d')!.putImageData(toImageData(img), 0, 0);
    }
    if (cur) {
      this.renderer.loadSource(cur.bitmap, cur.w, cur.h);
      this.stateDirty = true;
      this.request();
    }
  }

  selectedDocs(): Doc[] {
    return this.docs.filter((d) => this.selected.has(d.id));
  }

  openExport(batch = false) {
    if (!this.doc) return;
    exportDialog(this, batch);
  }

  /** 匯出指定照片（會暫時切換來源） */
  async exportDoc(d: Doc, opts: { mime: string; quality: number; long: number | null; suffix: string }) {
    const r = this.renderer;
    const cur = this.doc;
    if (d !== cur) r.loadSource(d.bitmap, d.w, d.h);
    const [fw, fh] = outputSize(d.w, d.h, d.state.geometry);
    const scale = opts.long ? Math.min(1, opts.long / Math.max(fw, fh)) : 1;
    const img = r.renderExport(scale, d.state);
    if (d !== cur && cur) { r.loadSource(cur.bitmap, cur.w, cur.h); }
    if (cur) { r.setState(cur.state); this.stateDirty = true; this.request(); }
    const blob = await this.analysis.encode(img.data, img.w, img.h, opts.mime, opts.quality);
    const ext = opts.mime === 'image/png' ? 'png' : opts.mime === 'image/webp' ? 'webp' : 'jpg';
    const base = d.name.replace(/\.[^.]+$/, '');
    const a = h('a', { href: URL.createObjectURL(blob), download: `${base}${opts.suffix}.${ext}` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { w: img.w, h: img.h, size: blob.size };
  }

  // ───────────── 鍵盤 ─────────────

  private bindKeys() {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    };
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-veil')) return;
      if (typing(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
      if (mod && k === 'y') { e.preventDefault(); return this.redo(); }
      if (mod && k === 'e') { e.preventDefault(); return this.openExport(); }
      if (mod && k === 'o') { e.preventDefault(); return this.openPicker(); }
      if (mod && e.shiftKey && k === 'c') { e.preventDefault(); return this.copySettings(); }
      if (mod && e.shiftKey && k === 'v') { e.preventDefault(); return this.pasteSettings(); }
      if (mod && (k === '0')) { e.preventDefault(); return this.vp.setZoom('fit'); }
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); return this.vp.setZoom(this.vp.scale * 1.25); }
      if (mod && k === '-') { e.preventDefault(); return this.vp.setZoom(this.vp.scale / 1.25); }
      if (mod) return;
      if (e.key === ' ') { this.vp.spaceDown = true; e.preventDefault(); return; }
      if (e.key === 'Alt') { e.preventDefault(); if (!this.showMaskHeld) { this.showMaskHeld = true; this.request(); } return; }
      if (e.key === '\\') { this.vp.showBefore = true; this.request(); return; }
      if (e.key === '?') return shortcutsDialog();
      if (e.key === 'Tab') { e.preventDefault(); return this.togglePanel(); }
      if (e.key === 'Escape' && this.root.querySelector('.app')!.classList.contains('chrome-hidden')) return this.toggleChrome();
      const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
      if (tool && !e.altKey) return this.setTool(this.tool === tool.id && tool.id !== 'adjust' ? 'adjust' : tool.id);
      if (k === 'h') return this.setTool(this.tool === 'history' ? 'adjust' : 'history');
      if (k === 'y') return this.toggleSplit();
      if (k === 'z') return this.vp.toggleOneToOne();
      if (k === 'f') return this.toggleChrome();
      this.currentPane()?.el.dispatchEvent(new CustomEvent('toolkey', { detail: e }));
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.vp.spaceDown = false;
      if (e.key === 'Alt') { this.showMaskHeld = false; this.request(); }
      if (e.key === '\\') { this.vp.showBefore = false; this.request(); }
    });
    window.addEventListener('blur', () => {
      this.vp.spaceDown = false;
      if (this.showMaskHeld) { this.showMaskHeld = false; this.request(); }
      this.vp.showBefore = false;
    });
  }

  private bindDrop() {
    const el = this.vp.el;
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; el.classList.add('drag'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('drag'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      el.classList.remove('drag');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.openFiles(files);
    });
    window.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) void this.openFiles(files);
    });
  }
}
