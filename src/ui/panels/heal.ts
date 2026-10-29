import { uid, type Spot } from '../../core/state';
import type { App, Pane } from '../app';
import { clamp, h, s } from '../dom';
import { Slider } from '../slider';
import { seg } from '../widgets';
import type { Overlay } from '../viewport';

const opts = { mode: 'heal' as Spot['mode'], size: 0.018, feather: 0.5, opacity: 1 };

export function healPane(app: App): Pane {
  let sel = -1;
  const ctx = { sel: () => sel, setSel: (i: number) => { sel = i; refresh(); } };
  const spot = () => app.state.spots[sel] ?? null;
  const editSel = (fn: (sp: Spot) => void, label: string, live: boolean) => {
    if (!spot()) return;
    app.update((st) => fn(st.spots[sel]), label, live);
  };

  const mode = seg([{ value: 'heal', label: '修復' }, { value: 'clone', label: '仿製' }], () => opts.mode, (v) => {
    opts.mode = v as Spot['mode'];
    editSel((sp) => (sp.mode = opts.mode), '修補模式', false);
  });
  const size = new Slider({ label: '大小', min: 0.3, max: 12, step: 0.1, def: 1.8, format: (v) => `${v.toFixed(1)}%`,
    get: () => (spot()?.r ?? opts.size) * 100,
    set: (v, live) => { opts.size = v / 100; editSel((sp) => (sp.r = v / 100), '修補大小', live); app.request(); } });
  const feather = new Slider({ label: '羽化', min: 0, max: 100, step: 1, def: 50,
    get: () => (spot()?.feather ?? opts.feather) * 100,
    set: (v, live) => { opts.feather = v / 100; editSel((sp) => (sp.feather = v / 100), '修補羽化', live); } });
  const opacity = new Slider({ label: '不透明度', min: 0, max: 100, step: 1, def: 100, format: (v) => `${Math.round(v)}%`,
    get: () => (spot()?.opacity ?? opts.opacity) * 100,
    set: (v, live) => { opts.opacity = v / 100; editSel((sp) => (sp.opacity = v / 100), '修補不透明度', live); } });
  const count = h('span.meta');
  const el = h('div',
    h('div.pane-title', h('h2', '修補'), count),
    h('section.sec.flat', { style: 'padding-top:0' }, h('div.sec-body', mode.el, size.el, feather.el, opacity.el)),
    h('div.hint', { html: '<b style="color:var(--text-0);font-weight:500">修復</b>：點一下污點，會自動在附近找紋理相近的地方補上，並校正顏色與亮度。<br><b style="color:var(--text-0);font-weight:500">仿製</b>：先按住 <kbd>Alt</kbd> 點來源，再點要蓋掉的地方。<br>拖曳圓圈可以移動目標或來源；<kbd>[</kbd> <kbd>]</kbd> 調整大小；<kbd>Delete</kbd> 刪除。' }),
  );
  el.addEventListener('toolkey', ((e: CustomEvent<KeyboardEvent>) => {
    const k = e.detail.key;
    if (k === '[' || k === ']') {
      const f = k === '[' ? 1 / 1.15 : 1.15;
      opts.size = clamp((spot()?.r ?? opts.size) * f, 0.003, 0.12);
      editSel((sp) => (sp.r = opts.size), '修補大小', false);
      size.refresh();
      app.request();
    }
    if ((k === 'Delete' || k === 'Backspace') && spot()) {
      app.update((st) => st.spots.splice(sel, 1), '刪除修補');
      sel = -1;
      refresh();
    }
  }) as EventListener);
  const clear = h('button.btn.ghost.danger', { type: 'button' }, '清除全部');
  clear.addEventListener('click', () => { app.update((st) => (st.spots = []), '清除修補'); sel = -1; refresh(); });

  const refresh = () => {
    if (sel >= app.state.spots.length) sel = -1;
    mode.refresh(); size.refresh(); feather.refresh(); opacity.refresh();
    count.textContent = app.state.spots.length ? `${app.state.spots.length} 處` : '';
  };
  return { el, foot: [clear], refresh, overlay: healOverlay(app, ctx) };
}

function healOverlay(app: App, ctx: { sel: () => number; setSel: (i: number) => void }): Overlay {
  let hover: [number, number] | null = null;
  let cloneSrc: [number, number] | null = null;
  let drag: { i: number; part: 'dst' | 'src'; start: [number, number]; sp: Spot } | null = null;
  const long = () => Math.max(app.renderer.srcW, app.renderer.srcH);
  const R = (r: number) => r * long() * app.vp.scale;

  return {
    cls: 'tool-heal',
    render(g, vp) {
      app.state.spots.forEach((sp, i) => {
        const d = vp.srcToScreen(sp.x, sp.y);
        const sel = i === ctx.sel();
        const r = R(sp.r);
        g.append(s('circle', { class: 'ov-line shadow', cx: d[0], cy: d[1], r }), s('circle', { class: `ov-line ${sel ? '' : 'dim'}`, cx: d[0], cy: d[1], r }));
        if (sel) {
          const src = vp.srcToScreen(sp.sx, sp.sy);
          g.append(
            s('line', { class: 'ov-line dim', x1: d[0], y1: d[1], x2: src[0], y2: src[1] }),
            s('circle', { class: 'ov-line shadow', cx: src[0], cy: src[1], r }),
            s('circle', { class: 'ov-line dash', cx: src[0], cy: src[1], r }),
            s('circle', { class: 'ov-handle', cx: src[0], cy: src[1], r: 4 }),
          );
        }
        g.append(s('circle', { class: `ov-pin ${sel ? 'sel' : ''}`, cx: d[0], cy: d[1], r: 4 }));
      });
      if (cloneSrc) {
        const c = vp.srcToScreen(...cloneSrc);
        g.append(s('path', { class: 'ov-line', d: `M${c[0] - 7} ${c[1]}H${c[0] + 7}M${c[0]} ${c[1] - 7}V${c[1] + 7}` }));
      }
      if (hover && !drag) {
        const r = R(app.state.spots[ctx.sel()]?.r ?? opts.size);
        g.append(s('circle', { class: 'ov-line shadow', cx: hover[0], cy: hover[1], r }), s('circle', { class: 'ov-cursor', cx: hover[0], cy: hover[1], r }));
      }
    },
    down(e, p) {
      const vp = app.vp;
      const spots = app.state.spots;
      // 點到已有的圓：選取並準備拖曳
      for (let i = spots.length - 1; i >= 0; i--) {
        const sp = spots[i];
        const d = vp.srcToScreen(sp.x, sp.y), src = vp.srcToScreen(sp.sx, sp.sy);
        const r = Math.max(8, R(sp.r));
        if (i === ctx.sel() && Math.hypot(src[0] - p[0], src[1] - p[1]) < r) { drag = { i, part: 'src', start: p, sp: { ...sp } }; return true; }
        if (Math.hypot(d[0] - p[0], d[1] - p[1]) < r) { ctx.setSel(i); drag = { i, part: 'dst', start: p, sp: { ...sp } }; app.request(); return true; }
      }
      const [u, v] = vp.screenToSrc(p[0], p[1]);
      if (u < 0 || v < 0 || u > 1 || v > 1) return false;
      if (e.altKey) { cloneSrc = [u, v]; opts.mode = 'clone'; app.stateChanged(false); return true; }
      const id = uid();
      const r = opts.size;
      const add = (sx: number, sy: number) => {
        app.update((st) => st.spots.push({ id, mode: opts.mode, x: u, y: v, sx, sy, r, feather: opts.feather, opacity: opts.opacity }), opts.mode === 'heal' ? '污點修復' : '仿製印章');
        ctx.setSel(app.state.spots.length - 1);
      };
      if (opts.mode === 'clone' && cloneSrc) {
        add(cloneSrc[0], cloneSrc[1]);
        // 之後的點擊沿用同樣的偏移
        const off = [cloneSrc[0] - u, cloneSrc[1] - v];
        cloneSrc = null;
        void off;
      } else if (app.doc) {
        void app.analysis.healSource(app.doc.id, u, v, r).then(([sx, sy]) => add(sx, sy));
      }
      return true;
    },
    move(_e, p) {
      hover = p;
      if (!drag) return;
      const a = app.vp.screenToSrc(...drag.start), b = app.vp.screenToSrc(p[0], p[1]);
      const du = b[0] - a[0], dv = b[1] - a[1];
      const { i, part, sp } = drag;
      app.update((st) => {
        const t = st.spots[i];
        if (!t) return;
        if (part === 'dst') { t.x = sp.x + du; t.y = sp.y + dv; t.sx = sp.sx + du; t.sy = sp.sy + dv; }
        else { t.sx = sp.sx + du; t.sy = sp.sy + dv; }
      }, '移動修補', true);
    },
    up() {
      if (drag) app.update(() => {}, '移動修補');
      drag = null;
    },
    hover(p) {
      hover = p;
      app.request();
    },
  };
}
