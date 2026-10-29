import { interpolateDabs } from '../../core/brush';
import { apply, invert, type Affine } from '../../core/geometry';
import { defaultLocal, LOCAL_KEYS, uid, type BrushDab, type LocalKey, type Mask } from '../../core/state';
import type { App, Pane } from '../app';
import { clamp, h, s, signed } from '../dom';
import { icons } from '../icons';
import { Slider } from '../slider';
import { toggle } from '../widgets';
import type { Overlay, Viewport } from '../viewport';
import { toast } from '../dialogs';

const MAX = 8;
const LOCAL_LABEL: Record<LocalKey, string> = { exposure: '曝光', contrast: '對比', highlights: '亮部', shadows: '陰影', temp: '色溫', tint: '色調', saturation: '飽和度', clarity: '清晰度', dehaze: '去霧' };
const TYPE_LABEL = { brush: '筆刷', linear: '線性漸層', radial: '徑向漸層' };
const TYPE_ICON = { brush: icons.brush, linear: icons.linear, radial: icons.radial };

export const brush = { size: 0.05, hardness: 0.5, flow: 0.6, erase: false };

/** SVG matrix() 用的順序 */
const svgMatrix = (m: Affine) => `matrix(${m[0]} ${m[3]} ${m[1]} ${m[4]} ${m[2]} ${m[5]})`;

export function maskPane(app: App): Pane {
  const sel = (): Mask | null => app.state.masks[app.maskSel] ?? null;

  const add = (type: Mask['type']) => {
    if (!app.doc) return;
    if (app.state.masks.length >= MAX) return toast(`最多 ${MAX} 個遮罩`, true);
    const vp = app.vp;
    const n = app.state.masks.filter((m) => m.type === type).length + 1;
    const base = { id: uid(), name: `${TYPE_LABEL[type]} ${n}`, visible: true, invert: false, adjust: { ...defaultLocal(), exposure: type === 'brush' ? 0.5 : 0 } };
    let m: Mask;
    // 預設位置以「目前畫面」為準，旋轉或裁切後也會出現在看得到的地方
    const toSrc = (u: number, v: number) => apply(vp.geo, u, v) as [number, number];
    if (type === 'linear') m = { ...base, type, a: toSrc(0.5, 0.15), b: toSrc(0.5, 0.55), adjust: { ...base.adjust, exposure: -0.6 } };
    else if (type === 'radial') {
      const [cx, cy] = toSrc(0.5, 0.5);
      m = { ...base, type, cx, cy, rx: 0.22, ry: 0.16, angle: 0, feather: 0.6, adjust: { ...base.adjust, exposure: 0.4 } };
    } else m = { ...base, type, dabs: [] };
    app.update((st) => st.masks.push(m), `新增${TYPE_LABEL[type]}`);
    app.maskSel = app.state.masks.length - 1;
    app.stateChanged(false);
  };

  const addRow = h('div.add-row',
    ...(['brush', 'linear', 'radial'] as const).map((t) => {
      const b = h('button.btn', { type: 'button', html: TYPE_ICON[t](16) + `<span>${TYPE_LABEL[t].slice(0, 2)}</span>` });
      b.addEventListener('click', () => add(t));
      app.tipFor(b, `新增${TYPE_LABEL[t]}`, { brush: 'B', linear: 'G', radial: 'O' }[t]);
      return b;
    }),
  );

  const list = h('div.list', { role: 'listbox', 'aria-label': '遮罩' });
  let listKey = '';
  const renderList = () => {
    const key = JSON.stringify(app.state.masks.map((m) => [m.id, m.name, m.visible, m.invert])) + app.maskSel;
    if (key === listKey) return;
    listKey = key;
    const masks = app.state.masks;
    if (!masks.length) { list.replaceChildren(h('div.empty-note', '還沒有遮罩。新增一個筆刷、線性或徑向漸層，再用下面的滑桿只調整那個區域。')); return; }
    list.replaceChildren(...masks.map((m, i) => {
      const eye = h('button.ib', { type: 'button', 'aria-label': m.visible ? '隱藏效果' : '顯示效果', html: m.visible ? icons.eye() : icons.eyeOff() });
      eye.addEventListener('click', (e) => { e.stopPropagation(); app.update((st) => (st.masks[i].visible = !st.masks[i].visible), '遮罩顯示'); });
      const del = h('button.ib', { type: 'button', 'aria-label': '刪除遮罩', html: icons.trash() });
      del.addEventListener('click', (e) => { e.stopPropagation(); remove(i); });
      const row = h('button.row', { type: 'button', role: 'option', 'aria-selected': String(i === app.maskSel), class: i === app.maskSel ? 'on' : '' },
        h('span.ico', { html: TYPE_ICON[m.type](16) }), h('span.grow', m.name), h('span.acts', eye, del));
      if (!m.visible) row.classList.add('future');
      row.addEventListener('click', () => { app.maskSel = i; app.stateChanged(false); });
      return row;
    }));
  };
  const remove = (i: number) => {
    app.update((st) => st.masks.splice(i, 1), '刪除遮罩');
    app.maskSel = Math.min(app.maskSel, app.state.masks.length - 1);
    app.stateChanged(false);
  };

  // 局部調整
  const locals = LOCAL_KEYS.map((k) => new Slider({
    label: LOCAL_LABEL[k],
    min: k === 'exposure' ? -4 : -100, max: k === 'exposure' ? 4 : 100, step: k === 'exposure' ? 0.01 : 1,
    format: k === 'exposure' ? (v) => signed(v, 2) : undefined,
    track: k === 'temp' ? 'linear-gradient(90deg,#4f7fd6,#9a9a9a 50%,#d9b54a)' : k === 'tint' ? 'linear-gradient(90deg,#5fae5a,#9a9a9a 50%,#c45fb9)' : undefined,
    get: () => sel()?.adjust[k] ?? 0,
    set: (v, live) => app.update((st) => { const m = st.masks[app.maskSel]; if (m) m.adjust[k] = v; }, `遮罩：${LOCAL_LABEL[k]}`, live),
  }));
  const inv = toggle('反轉遮罩', () => !!sel()?.invert, (v) => app.update((st) => { const m = st.masks[app.maskSel]; if (m) m.invert = v; }, '反轉遮罩'));
  const feather = new Slider({
    label: '羽化', min: 0, max: 100, step: 1, def: 60,
    get: () => { const m = sel(); return m?.type === 'radial' ? m.feather * 100 : 0; },
    set: (v, live) => app.update((st) => { const m = st.masks[app.maskSel]; if (m?.type === 'radial') m.feather = Math.max(0.01, v / 100); }, '羽化', live),
  });
  const bSize = new Slider({ label: '筆刷大小', min: 0.5, max: 30, step: 0.1, def: 5, format: (v) => `${v.toFixed(1)}%`, get: () => brush.size * 100, set: (v) => { brush.size = v / 100; app.request(); } });
  const bHard = new Slider({ label: '硬度', min: 0, max: 100, step: 1, def: 50, get: () => brush.hardness * 100, set: (v) => (brush.hardness = v / 100) });
  const bFlow = new Slider({ label: '流量', min: 1, max: 100, step: 1, def: 60, get: () => brush.flow * 100, set: (v) => (brush.flow = v / 100) });
  const bErase = toggle('擦除（或按住 Alt 塗抹）', () => brush.erase, (v) => (brush.erase = v));
  const brushBox = h('div', h('div.sub', '筆刷'), bSize.el, bHard.el, bFlow.el, bErase.el);
  const showMask = h('button.btn.sm', { type: 'button' }, '顯示遮罩範圍');
  showMask.addEventListener('click', () => { app.showMaskHeld = !app.showMaskHeld; showMask.classList.toggle('on', app.showMaskHeld); app.request(); });

  const detail = h('section.sec.flat', h('div.sec-flat-head', h('h3', '局部調整'), showMask), h('div.sec-body', inv.el, h('div', { style: 'height:6px' }), ...locals.map((l) => l.el), feather.el, brushBox));
  const el = h('div',
    h('div.pane-title', h('h2', '局部遮罩'), h('span.meta', `最多 ${MAX} 個`)),
    addRow, list, detail,
    h('div.hint', { html: '按住 <kbd>Alt</kbd> 以紅色顯示遮罩範圍；<kbd>[</kbd> <kbd>]</kbd> 調整筆刷大小；<kbd>Delete</kbd> 刪除選取的遮罩。' }),
  );

  el.addEventListener('toolkey', ((e: CustomEvent<KeyboardEvent>) => {
    const k = e.detail.key.toLowerCase();
    if (k === 'b') add('brush');
    else if (k === 'g') add('linear');
    else if (k === 'o') add('radial');
    else if (k === '[') { brush.size = clamp(brush.size / 1.15, 0.005, 0.3); bSize.refresh(); app.request(); }
    else if (k === ']') { brush.size = clamp(brush.size * 1.15, 0.005, 0.3); bSize.refresh(); app.request(); }
    else if ((k === 'delete' || k === 'backspace') && sel()) remove(app.maskSel);
  }) as EventListener);

  const clear = h('button.btn.ghost.danger', { type: 'button' }, '清除全部遮罩');
  clear.addEventListener('click', () => { app.update((st) => (st.masks = []), '清除遮罩'); app.maskSel = -1; app.stateChanged(false); });

  return {
    el,
    foot: [clear],
    overlay: maskOverlay(app),
    refresh() {
      if (app.maskSel >= app.state.masks.length) app.maskSel = app.state.masks.length - 1;
      if (app.maskSel < 0 && app.state.masks.length) app.maskSel = 0;
      renderList();
      const m = sel();
      detail.hidden = !m;
      locals.forEach((l) => l.refresh());
      inv.refresh();
      feather.el.hidden = m?.type !== 'radial';
      feather.refresh();
      brushBox.hidden = m?.type !== 'brush';
      bSize.refresh(); bHard.refresh(); bFlow.refresh(); bErase.refresh();
    },
    hide() { app.showMaskHeld = false; showMask.classList.remove('on'); },
  };
}

function maskOverlay(app: App): Overlay {
  let hover: [number, number] | null = null;
  type Drag =
    | { kind: 'paint'; last: BrushDab; erase: boolean }
    | { kind: 'radial'; part: 'center' | 'rx' | 'ry' | 'rot' | 'feather'; start: [number, number]; m: Extract<Mask, { type: 'radial' }> }
    | { kind: 'linear'; part: 'a' | 'b' | 'mid'; start: [number, number]; m: Extract<Mask, { type: 'linear' }> };
  let drag: Drag | null = null;

  const long = () => Math.max(app.renderer.srcW, app.renderer.srcH);
  /** 長邊單位 → 螢幕 */
  const longToScreen = (vp: Viewport): Affine => {
    const M = vp.srcToScreenMatrix();
    const kx = long() / app.renderer.srcW, ky = long() / app.renderer.srcH;
    return [M[0] * kx, M[1] * ky, M[2], M[3] * kx, M[4] * ky, M[5]];
  };
  const screenToLong = (vp: Viewport, p: [number, number]) => apply(invert(longToScreen(vp)), p[0], p[1]);
  const radialPts = (vp: Viewport, m: Extract<Mask, { type: 'radial' }>) => {
    const T = longToScreen(vp);
    const cxL = (m.cx * app.renderer.srcW) / long(), cyL = (m.cy * app.renderer.srcH) / long();
    const ca = Math.cos(m.angle), sa = Math.sin(m.angle);
    const at = (x: number, y: number) => apply(T, cxL + ca * x - sa * y, cyL + sa * x + ca * y);
    return {
      center: at(0, 0), rx: at(m.rx, 0), ry: at(0, -m.ry), rot: at(m.rx * 1.25 + 0.02, 0), feather: at(0, -m.ry * (1 - m.feather)),
      T, cxL, cyL,
    };
  };
  const screenR = (vp: Viewport, r: number) => r * long() * vp.scale;

  return {
    get cls() {
      const m = app.state.masks[app.maskSel];
      return m?.type === 'brush' ? 'tool-brush' : 'tool-mask';
    },
    render(g, vp) {
      const masks = app.state.masks;
      masks.forEach((m, i) => {
        const selected = i === app.maskSel;
        if (m.type === 'radial') {
          const P = radialPts(vp, m);
          if (selected) {
            const grp = s('g', { transform: svgMatrix(P.T) });
            const rot = `rotate(${(m.angle * 180) / Math.PI} ${P.cxL} ${P.cyL})`;
            grp.append(
              s('ellipse', { class: 'ov-line shadow', cx: P.cxL, cy: P.cyL, rx: m.rx, ry: m.ry, transform: rot }),
              s('ellipse', { class: 'ov-line', cx: P.cxL, cy: P.cyL, rx: m.rx, ry: m.ry, transform: rot }),
              s('ellipse', { class: 'ov-line dash dim', cx: P.cxL, cy: P.cyL, rx: m.rx * (1 - m.feather), ry: m.ry * (1 - m.feather), transform: rot }),
            );
            g.append(grp);
            g.append(s('line', { class: 'ov-line dim', x1: P.rx[0], y1: P.rx[1], x2: P.rot[0], y2: P.rot[1] }));
            for (const [p, r, cls] of [[P.rx, 5, 'ov-handle'], [P.ry, 5, 'ov-handle'], [P.feather, 4, 'ov-handle accent'], [P.rot, 4, 'ov-handle']] as const)
              g.append(s('circle', { class: cls, cx: p[0], cy: p[1], r }));
          }
          g.append(s('circle', { class: `ov-pin ${selected ? 'sel' : ''}`, cx: P.center[0], cy: P.center[1], r: 6 }));
        } else if (m.type === 'linear') {
          const A = vp.srcToScreen(...m.a), B = vp.srcToScreen(...m.b);
          const dx = B[0] - A[0], dy = B[1] - A[1];
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len;
          const L = 5000;
          const line = (p: [number, number], cls: string) => s('line', { class: cls, x1: p[0] - nx * L, y1: p[1] - ny * L, x2: p[0] + nx * L, y2: p[1] + ny * L });
          const M: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
          if (selected) {
            const [rx, ry, rw, rh] = vp.rect;
            const clipId = 'clip-img';
            const cp = s('clipPath', { id: clipId });
            cp.append(s('rect', { x: rx, y: ry, width: rw, height: rh }));
            const grp = s('g', { 'clip-path': `url(#${clipId})` });
            grp.append(line(A, 'ov-line shadow'), line(A, 'ov-line'), line(M, 'ov-line dash dim'), line(B, 'ov-line shadow'), line(B, 'ov-line dim'));
            g.append(cp, grp, s('line', { class: 'ov-line dim', x1: A[0], y1: A[1], x2: B[0], y2: B[1] }));
            g.append(s('circle', { class: 'ov-handle', cx: A[0], cy: A[1], r: 5 }), s('circle', { class: 'ov-handle', cx: B[0], cy: B[1], r: 5 }));
          }
          g.append(s('circle', { class: `ov-pin ${selected ? 'sel' : ''}`, cx: M[0], cy: M[1], r: 6 }));
        }
      });
      const m = masks[app.maskSel];
      if (m?.type === 'brush' && hover) {
        const r = screenR(vp, brush.size);
        g.append(
          s('circle', { class: 'ov-line shadow', cx: hover[0], cy: hover[1], r }),
          s('circle', { class: 'ov-cursor', cx: hover[0], cy: hover[1], r }),
          s('circle', { class: 'ov-cursor-in', cx: hover[0], cy: hover[1], r: r * brush.hardness }),
        );
        if (brush.erase) g.append(s('line', { class: 'ov-cursor', x1: hover[0] - 4, y1: hover[1], x2: hover[0] + 4, y2: hover[1] }));
      }
    },
    down(e, p) {
      const vp = app.vp;
      const masks = app.state.masks;
      // 先看有沒有點到任何一個遮罩的中心點（切換選取）
      for (let i = masks.length - 1; i >= 0; i--) {
        const m = masks[i];
        let c: [number, number] | null = null;
        if (m.type === 'radial') c = radialPts(vp, m).center;
        else if (m.type === 'linear') { const A = vp.srcToScreen(...m.a), B = vp.srcToScreen(...m.b); c = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]; }
        if (c && Math.hypot(c[0] - p[0], c[1] - p[1]) < 10) {
          if (app.maskSel !== i) { app.maskSel = i; app.stateChanged(false); }
          drag = m.type === 'radial' ? { kind: 'radial', part: 'center', start: p, m: structuredClone(m) } : { kind: 'linear', part: 'mid', start: p, m: structuredClone(m as Extract<Mask, { type: 'linear' }>) };
          return true;
        }
      }
      const m = masks[app.maskSel];
      if (!m) return false;
      if (m.type === 'radial') {
        const P = radialPts(vp, m);
        for (const part of ['rx', 'ry', 'rot', 'feather'] as const) {
          if (Math.hypot(P[part][0] - p[0], P[part][1] - p[1]) < 10) { drag = { kind: 'radial', part, start: p, m: structuredClone(m) }; return true; }
        }
        return false;
      }
      if (m.type === 'linear') {
        for (const part of ['a', 'b'] as const) {
          const q = vp.srcToScreen(...m[part]);
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 10) { drag = { kind: 'linear', part, start: p, m: structuredClone(m) }; return true; }
        }
        return false;
      }
      // 筆刷
      const [u, v] = vp.screenToSrc(p[0], p[1]);
      const dab: BrushDab = { x: u, y: v, r: brush.size, hardness: brush.hardness, flow: brush.flow, erase: brush.erase || e.altKey };
      drag = { kind: 'paint', last: dab, erase: dab.erase };
      app.update((st) => { const mm = st.masks[app.maskSel]; if (mm?.type === 'brush') mm.dabs.push(dab); }, '筆刷', true);
      return true;
    },
    move(_e, p) {
      if (!drag) return;
      const vp = app.vp;
      hover = p;
      if (drag.kind === 'paint') {
        const [u, v] = vp.screenToSrc(p[0], p[1]);
        const to: BrushDab = { ...drag.last, x: u, y: v };
        const dabs = interpolateDabs(drag.last, to, app.renderer.srcW / app.renderer.srcH);
        if (!dabs.length) { app.request(); return; }
        drag.last = dabs[dabs.length - 1];
        app.update((st) => { const mm = st.masks[app.maskSel]; if (mm?.type === 'brush') mm.dabs.push(...dabs); }, '筆刷', true);
        return;
      }
      if (drag.kind === 'radial') {
        const o = drag.m;
        const q = screenToLong(vp, p);
        const q0 = screenToLong(vp, drag.start);
        const W = app.renderer.srcW, H = app.renderer.srcH, L = long();
        const cxL = (o.cx * W) / L, cyL = (o.cy * H) / L;
        const lx = q[0] - cxL, ly = q[1] - cyL;
        const ca = Math.cos(o.angle), sa = Math.sin(o.angle);
        const ax = ca * lx + sa * ly, ay = -sa * lx + ca * ly; // 轉到橢圓自己的座標
        const part = drag.part;
        app.update((st) => {
          const m = st.masks[app.maskSel];
          if (m?.type !== 'radial') return;
          if (part === 'center') { m.cx = o.cx + ((q[0] - q0[0]) * L) / W; m.cy = o.cy + ((q[1] - q0[1]) * L) / H; }
          else if (part === 'rx') m.rx = Math.max(0.01, Math.abs(ax));
          else if (part === 'ry') m.ry = Math.max(0.01, Math.abs(ay));
          else if (part === 'rot') m.angle = Math.atan2(ly, lx);
          else if (part === 'feather') m.feather = clamp(1 - Math.abs(ay) / o.ry, 0.01, 1);
        }, '徑向漸層', true);
        return;
      }
      const o = drag.m;
      const d0 = vp.screenToSrc(...drag.start), d1 = vp.screenToSrc(p[0], p[1]);
      const du = d1[0] - d0[0], dv = d1[1] - d0[1];
      const part = drag.part;
      app.update((st) => {
        const m = st.masks[app.maskSel];
        if (m?.type !== 'linear') return;
        if (part === 'a' || part === 'mid') m.a = [o.a[0] + du, o.a[1] + dv];
        if (part === 'b' || part === 'mid') m.b = [o.b[0] + du, o.b[1] + dv];
      }, '線性漸層', true);
    },
    up() {
      if (drag) {
        const label = drag.kind === 'paint' ? '筆刷' : drag.kind === 'radial' ? '徑向漸層' : '線性漸層';
        app.update(() => {}, label);
      }
      drag = null;
    },
    hover(p) {
      hover = p;
      const m = app.state.masks[app.maskSel];
      if (m?.type === 'brush') app.request();
    },
  };
}
