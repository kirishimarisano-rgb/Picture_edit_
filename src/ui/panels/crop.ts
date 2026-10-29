import { aspectRatio, cropFits, cropForAspect, fitCrop } from '../../core/geometry';
import { defaultGeometry, type Geometry } from '../../core/state';
import type { App, Pane } from '../app';
import { clamp, h, s } from '../dom';
import { icons } from '../icons';
import { Slider } from '../slider';
import type { Overlay, Viewport } from '../viewport';
import { toast } from '../dialogs';

type Crop = Geometry['crop'];
const ASPECTS = ['original', 'free', '1:1', '4:5', '3:2', '16:9'];
const ASPECT_LABEL: Record<string, string> = { original: '原始', free: '自由', '1:1': '1:1', '4:5': '4:5', '3:2': '3:2', '16:9': '16:9' };

export function cropPane(app: App): Pane {
  const g = () => app.state.geometry;
  const W = () => app.renderer.srcW, H = () => app.renderer.srcH;

  const setGeo = (fn: (g: Geometry) => void, label: string, live = false) =>
    app.update((st) => { fn(st.geometry); }, label, live);

  const straighten = new Slider({
    label: '拉直', min: -45, max: 45, step: 0.1, format: (v) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}°`,
    get: () => g().angle,
    set: (v, live) => setGeo((gg) => { gg.angle = v; gg.crop = fitCrop(W(), H(), gg); }, '拉直', live),
  });
  const autoBtn = h('button.btn.sm', { type: 'button', html: icons.level(14) + '<span>自動拉直</span>' });
  autoBtn.addEventListener('click', async () => {
    if (!app.doc) return;
    autoBtn.disabled = true;
    try {
      let a = await app.analysis.tilt(app.doc.id);
      if (g().flipH !== g().flipV) a = -a;
      if (Math.abs(a) < 0.05) toast('看起來已經是水平的了');
      setGeo((gg) => { gg.angle = Math.round(a * 10) / 10; gg.crop = fitCrop(W(), H(), { ...gg, crop: cropForAspect(gg.aspect, W(), H(), gg) }); }, '自動拉直');
    } finally {
      autoBtn.disabled = false;
    }
  });

  const chips = h('div.chips');
  const chipBtns = ASPECTS.map((a) => {
    const b = h('button.chip', { type: 'button' }, ASPECT_LABEL[a]);
    b.addEventListener('click', () => {
      let asp = a;
      // 依照目前畫框方向決定直式或橫式
      if (a.includes(':') && a !== '1:1') {
        const [p, q] = a.split(':').map(Number);
        const cur = g();
        const portrait = (cur.crop.h * (cur.rot90 % 2 ? W() : H())) > (cur.crop.w * (cur.rot90 % 2 ? H() : W()));
        asp = portrait === p > q ? `${q}:${p}` : a;
      }
      setGeo((gg) => { gg.aspect = asp; gg.crop = cropForAspect(asp, W(), H(), gg); }, '裁切比例');
    });
    chips.append(b);
    return b;
  });
  const swap = h('button.chip', { type: 'button', title: '直橫互換' }, '⇄ 直橫');
  swap.addEventListener('click', () => {
    const a = g().aspect;
    if (!a.includes(':')) return;
    const [p, q] = a.split(':');
    const n = `${q}:${p}`;
    setGeo((gg) => { gg.aspect = n; gg.crop = cropForAspect(n, W(), H(), gg); }, '裁切比例');
  });
  chips.append(swap);

  const rot = (d: 1 | -1) => setGeo((gg) => {
    gg.rot90 = (gg.rot90 + d + 4) % 4;
    const c = gg.crop;
    // 裁切框跟著轉
    gg.crop = d === 1 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
    if (gg.aspect.includes(':')) { const [p, q] = gg.aspect.split(':'); gg.aspect = `${q}:${p}`; }
    gg.crop = fitCrop(W(), H(), gg);
  }, d === 1 ? '向右旋轉' : '向左旋轉');
  const flip = (axis: 'h' | 'v') => setGeo((gg) => {
    if (axis === 'h') { gg.flipH = !gg.flipH; gg.crop = { ...gg.crop, x: 1 - gg.crop.x - gg.crop.w }; gg.angle = -gg.angle; }
    else { gg.flipV = !gg.flipV; gg.crop = { ...gg.crop, y: 1 - gg.crop.y - gg.crop.h }; gg.angle = -gg.angle; }
    gg.crop = fitCrop(W(), H(), gg);
  }, axis === 'h' ? '水平翻轉' : '垂直翻轉');
  const tbtn = (icon: string, label: string, fn: () => void) => {
    const b = h('button.ib', { type: 'button', 'aria-label': label, title: label, html: icon });
    b.addEventListener('click', fn);
    return b;
  };
  const tools = h('div', { style: 'display:flex;gap:4px;margin:2px 0 8px' },
    tbtn(icons.rotL(), '向左旋轉 90°', () => rot(-1)),
    tbtn(icons.rotR(), '向右旋轉 90°', () => rot(1)),
    tbtn(icons.flipH(), '水平翻轉', () => flip('h')),
    tbtn(icons.flipV(), '垂直翻轉', () => flip('v')),
  );

  const el = h('div',
    h('div.pane-title', h('h2', '裁切與拉直')),
    h('section.sec.flat', { style: 'padding-top:0' }, h('div.sec-body',
      h('div.sub', '比例'), chips,
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('div.sub', '拉直'), autoBtn),
      straighten.el,
      h('div.sub', '旋轉與翻轉'), tools,
    )),
    h('div.hint', { html: '拖曳框內移動、拖曳把手調整大小、在框外拖曳可以旋轉。<br><kbd>Enter</kbd> 完成，<kbd>Esc</kbd> 取消這次裁切。' }),
  );

  const reset = h('button.btn.ghost', { type: 'button' }, '重設');
  reset.addEventListener('click', () => setGeo((gg) => Object.assign(gg, defaultGeometry()), '重設裁切'));
  const done = h('button.btn.primary', { type: 'button' }, '完成');
  done.addEventListener('click', () => app.setTool('adjust'));

  let entry: Geometry | null = null;
  el.addEventListener('toolkey', ((e: CustomEvent<KeyboardEvent>) => {
    if (e.detail.key === 'Enter') app.setTool('adjust');
    if (e.detail.key === 'Escape' && entry) {
      const back = structuredClone(entry);
      app.update((st) => (st.geometry = back), '取消裁切');
      app.setTool('adjust');
    }
  }) as EventListener);

  const overlay = cropOverlay(app);
  return {
    el,
    foot: [reset, done],
    overlay,
    refresh() {
      straighten.refresh();
      chipBtns.forEach((b, i) => {
        const a = g().aspect;
        const base = a.includes(':') && a !== '1:1' ? (() => { const [p, q] = a.split(':').map(Number); return p > q ? a : `${q}:${p}`; })() : a;
        b.classList.toggle('on', ASPECTS[i] === base);
      });
    },
    show() {
      entry = structuredClone(g());
      app.vp.setHint('拖曳框外可以旋轉 · <kbd>Enter</kbd> 完成');
      setTimeout(() => app.vp.setHint(null), 2600);
    },
    hide() {
      app.vp.setHint(null);
      entry = null;
    },
  };
}

function cropOverlay(app: App): Overlay {
  type Mode = { kind: 'move' } | { kind: 'rotate'; a0: number; ang0: number } | { kind: 'resize'; hx: number; hy: number };
  let drag: { mode: Mode; start: [number, number]; crop: Crop } | null = null;
  let active = false;
  const W = () => app.renderer.srcW, H = () => app.renderer.srcH;
  const handles = (vp: Viewport, c: Crop) => {
    const pts: [number, number, number, number][] = [];
    for (const hx of [0, 0.5, 1]) for (const hy of [0, 0.5, 1]) {
      if (hx === 0.5 && hy === 0.5) continue;
      const [x, y] = vp.outToScreen(c.x + c.w * hx, c.y + c.h * hy);
      pts.push([x, y, hx, hy]);
    }
    return pts;
  };

  /** 把新的裁切框限制在影像內：不行就往舊的方向退 */
  const settle = (old: Crop, next: Crop): Crop => {
    const g = app.state.geometry;
    const fits = (c: Crop) => c.w > 0.02 && c.h > 0.02 && cropFits(W(), H(), g, c);
    if (fits(next)) return next;
    let lo = 0, hi = 1;
    const lerp = (t: number): Crop => ({ x: old.x + (next.x - old.x) * t, y: old.y + (next.y - old.y) * t, w: old.w + (next.w - old.w) * t, h: old.h + (next.h - old.h) * t });
    for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (fits(lerp(m))) lo = m; else hi = m; }
    return lerp(lo);
  };

  return {
    cls: 'tool-crop',
    render(gEl, vp) {
      const c = app.state.geometry.crop;
      const [x0, y0] = vp.outToScreen(c.x, c.y);
      const [x1, y1] = vp.outToScreen(c.x + c.w, c.y + c.h);
      const [rx, ry, rw, rh] = vp.rect;
      gEl.append(s('path', { class: 'ov-shade', 'fill-rule': 'evenodd', d: `M${rx} ${ry}h${rw}v${rh}h${-rw}z M${x0} ${y0}V${y1}H${x1}V${y0}z` }));
      const grid = s('path', { class: `ov-line ${active ? '' : 'dim'}`, d: [1, 2].map((i) => `M${x0 + ((x1 - x0) * i) / 3} ${y0}V${y1}M${x0} ${y0 + ((y1 - y0) * i) / 3}H${x1}`).join('') });
      gEl.append(grid, s('rect', { class: 'ov-line', x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
      const L = 16;
      for (const [x, y, hx, hy] of handles(vp, c)) {
        const sx = hx === 0 ? 1 : hx === 1 ? -1 : 0, sy = hy === 0 ? 1 : hy === 1 ? -1 : 0;
        const d = sx && sy ? `M${x} ${y + sy * L}V${y}H${x + sx * L}` : sx ? `M${x} ${y - L / 2}V${y + L / 2}` : `M${x - L / 2} ${y}H${x + L / 2}`;
        gEl.append(s('path', { class: 'ov-corner', d }));
      }
    },
    down(e, p) {
      const vp = app.vp;
      const c = app.state.geometry.crop;
      const hit = handles(vp, c).find(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 16);
      let mode: Mode;
      if (hit) mode = { kind: 'resize', hx: hit[2], hy: hit[3] };
      else {
        const [u, v] = vp.screenToOut(p[0], p[1]);
        if (u >= c.x && u <= c.x + c.w && v >= c.y && v <= c.y + c.h) mode = { kind: 'move' };
        else {
          const [cx, cy] = vp.outToScreen(c.x + c.w / 2, c.y + c.h / 2);
          mode = { kind: 'rotate', a0: Math.atan2(p[1] - cy, p[0] - cx), ang0: app.state.geometry.angle };
        }
      }
      drag = { mode, start: p, crop: { ...c } };
      active = true;
      void e;
      return true;
    },
    move(e, p) {
      if (!drag) return;
      const vp = app.vp;
      const [u0, v0] = vp.screenToOut(...drag.start);
      const [u1, v1] = vp.screenToOut(p[0], p[1]);
      const du = u1 - u0, dv = v1 - v0;
      const o = drag.crop;
      const geo = app.state.geometry;
      if (drag.mode.kind === 'rotate') {
        const [cx, cy] = vp.outToScreen(o.x + o.w / 2, o.y + o.h / 2);
        const a = Math.atan2(p[1] - cy, p[0] - cx);
        let ang = drag.mode.ang0 + ((a - drag.mode.a0) * 180) / Math.PI;
        if (e.shiftKey) ang = Math.round(ang);
        ang = clamp(ang, -45, 45);
        app.update((st) => { st.geometry.angle = Math.round(ang * 10) / 10; st.geometry.crop = fitCrop(W(), H(), { ...st.geometry, crop: o }); }, '拉直', true);
        return;
      }
      let n: Crop;
      if (drag.mode.kind === 'move') {
        n = { ...o, x: clamp(o.x + du, 0, 1 - o.w), y: clamp(o.y + dv, 0, 1 - o.h) };
      } else {
        const { hx, hy } = drag.mode;
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        if (hx === 0) x0 = clamp(x0 + du, 0, x1 - 0.02);
        if (hx === 1) x1 = clamp(x1 + du, x0 + 0.02, 1);
        if (hy === 0) y0 = clamp(y0 + dv, 0, y1 - 0.02);
        if (hy === 1) y1 = clamp(y1 + dv, y0 + 0.02, 1);
        const r = aspectRatio(geo.aspect, W(), H(), geo);
        if (r !== null && !e.altKey) {
          // 鎖比例：以拖動方向為主，另一邊跟著算
          let w = x1 - x0, hh = y1 - y0;
          if (hx === 0.5) w = hh * r;
          else if (hy === 0.5) hh = w / r;
          else if (w / hh > r) w = hh * r; else hh = w / r;
          if (hx === 0) x0 = x1 - w; else if (hx === 1) x1 = x0 + w; else { const cx = (o.x + o.x + o.w) / 2; x0 = cx - w / 2; x1 = cx + w / 2; }
          if (hy === 0) y0 = y1 - hh; else if (hy === 1) y1 = y0 + hh; else { const cy = (o.y + o.y + o.h) / 2; y0 = cy - hh / 2; y1 = cy + hh / 2; }
        }
        n = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      const cur = geo.crop;
      const settled = settle(cur, n);
      app.update((st) => (st.geometry.crop = settled), '裁切', true);
    },
    up() {
      if (drag) app.update(() => {}, drag.mode.kind === 'rotate' ? '拉直' : '裁切');
      drag = null;
      active = false;
      app.request();
    },
  };
}
