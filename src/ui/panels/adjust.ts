import { defaultBasic, defaultCurves, defaultHsl, defaultSplit, HSL_BANDS, sectionModified, uid, extractLook, type Basic, type Curves, type HslBand } from '../../core/state';
import { loadUserPresets, saveUserPresets } from '../../core/presets';
import type { App, Pane } from '../app';
import { h, signed } from '../dom';
import { icons } from '../icons';
import { Slider } from '../slider';
import { CurveEditor, flatSection, Ruler, Section, seg } from '../widgets';
import { ask, toast } from '../dialogs';

type Def = { key: keyof Basic; label: string; min: number; max: number; step: number; track?: string; fmt?: (v: number) => string };

export const BASIC_DEFS: Record<'light' | 'color' | 'detail', Def[]> = {
  light: [
    { key: 'exposure', label: '曝光', min: -5, max: 5, step: 0.01, fmt: (v) => signed(v, 2) },
    { key: 'contrast', label: '對比', min: -100, max: 100, step: 1 },
    { key: 'highlights', label: '亮部', min: -100, max: 100, step: 1 },
    { key: 'shadows', label: '陰影', min: -100, max: 100, step: 1 },
    { key: 'whites', label: '白色', min: -100, max: 100, step: 1 },
    { key: 'blacks', label: '黑色', min: -100, max: 100, step: 1 },
  ],
  color: [
    { key: 'temp', label: '色溫', min: -100, max: 100, step: 1, track: 'linear-gradient(90deg,#4f7fd6,#9a9a9a 50%,#d9b54a)' },
    { key: 'tint', label: '色調', min: -100, max: 100, step: 1, track: 'linear-gradient(90deg,#5fae5a,#9a9a9a 50%,#c45fb9)' },
    { key: 'vibrance', label: '自然飽和度', min: -100, max: 100, step: 1 },
    { key: 'saturation', label: '飽和度', min: -100, max: 100, step: 1 },
  ],
  detail: [
    { key: 'clarity', label: '清晰度', min: -100, max: 100, step: 1 },
    { key: 'dehaze', label: '去霧', min: -100, max: 100, step: 1 },
  ],
};

const BAND_LABEL: Record<HslBand, string> = { red: '紅', orange: '橙', yellow: '黃', green: '綠', aqua: '青', blue: '藍', purple: '紫', magenta: '洋紅' };
const BAND_HUE: Record<HslBand, number> = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 280, magenta: 320 };
const hsl = (hue: number, s = 70, l = 52) => `hsl(${hue} ${s}% ${l}%)`;
const rainbow = 'linear-gradient(90deg,' + [0, 40, 80, 120, 160, 200, 240, 280, 320, 360].map((d) => hsl(d, 60, 50)).join(',') + ')';

export function adjustPane(app: App): Pane {
  const sliders: Slider[] = [];
  const sections: Section[] = [];

  const basic = (d: Def) => {
    const sl = new Slider({
      label: d.label, min: d.min, max: d.max, step: d.step, track: d.track, format: d.fmt,
      get: () => app.state.basic[d.key],
      set: (v, live) => app.update((s) => (s.basic[d.key] = v), d.label, live),
    });
    sliders.push(sl);
    return sl.el;
  };

  const auto = h('button.btn.sm', { type: 'button', title: '依直方圖自動調整曝光、白色與黑色' }, '自動');
  auto.addEventListener('click', () => autoTone(app));

  // 曲線
  let ch: keyof Curves = 'rgb';
  const curveColor = () => ({ rgb: '#e8e8e8', r: '#ff7a6b', g: '#7fd28c', b: '#7ea8ff' })[ch];
  const curve = new CurveEditor(
    () => app.state.curves[ch],
    (pts, live) => app.update((s) => (s.curves[ch] = pts), '曲線', live),
    curveColor,
  );
  app.onHistogram(() => curve.setHistogram(app.lastHisto?.l ?? null));
  const chSeg = seg<keyof Curves>([
    { value: 'rgb', label: 'RGB' },
    { value: 'r', label: '紅', attrs: { 'data-ch': 'r' } },
    { value: 'g', label: '綠', attrs: { 'data-ch': 'g' } },
    { value: 'b', label: '藍', attrs: { 'data-ch': 'b' } },
  ], () => ch, (v) => { ch = v; curve.refresh(); }, 'channels');
  const curveSec = new Section({
    title: '曲線', key: 'adj-curves',
    modified: () => sectionModified(app.state, 'curves'),
    disabled: { get: () => !!app.state.disabled.curves, toggle: () => app.update((s) => (s.disabled.curves = !s.disabled.curves), '曲線開關') },
    reset: () => app.update((s) => (s.curves = defaultCurves()), '重設曲線'),
  }, chSeg.el, curve.el, h('div.sub', '點擊加點 · 拖曳調整 · 雙擊點刪除 · 雙擊空白重設此通道'));
  sections.push(curveSec);

  // HSL
  let mode: 0 | 1 | 2 = 0;
  const hslSliders = HSL_BANDS.map((band) => {
    const sl = new Slider({
      label: BAND_LABEL[band], min: -100, max: 100, step: 1,
      track: '',
      get: () => app.state.hsl[band][mode],
      set: (v, live) => app.update((s) => { s.hsl[band] = [...s.hsl[band]] as [number, number, number]; s.hsl[band][mode] = v; }, 'HSL', live),
    });
    return { band, sl };
  });
  const paintHslTracks = () => {
    for (const { band, sl } of hslSliders) {
      const c = BAND_HUE[band];
      const g = mode === 0 ? `linear-gradient(90deg,${hsl(c - 30)},${hsl(c)},${hsl(c + 30)})`
        : mode === 1 ? `linear-gradient(90deg,${hsl(c, 0)},${hsl(c, 85)})`
        : `linear-gradient(90deg,${hsl(c, 60, 18)},${hsl(c, 60, 50)},${hsl(c, 60, 82)})`;
      const rail = sl.el.querySelector('.sl-rail') as HTMLElement;
      rail.style.background = g;
      sl.el.querySelector('.sl-track')!.classList.add('functional');
      sl.refresh();
    }
  };
  const modeSeg = seg([
    { value: '0', label: '色相' },
    { value: '1', label: '飽和度' },
    { value: '2', label: '明度' },
  ], () => String(mode), (v) => { mode = +v as 0 | 1 | 2; paintHslTracks(); });
  const hslSec = new Section({
    title: 'HSL 混色器', key: 'adj-hsl',
    modified: () => sectionModified(app.state, 'hsl'),
    disabled: { get: () => !!app.state.disabled.hsl, toggle: () => app.update((s) => (s.disabled.hsl = !s.disabled.hsl), 'HSL 開關') },
    reset: () => app.update((s) => (s.hsl = defaultHsl()), '重設 HSL'),
  }, modeSeg.el, ...hslSliders.map((x) => x.sl.el));
  paintHslTracks();
  sections.push(hslSec);

  // 分離色調
  const split = (key: keyof ReturnType<typeof defaultSplit>, label: string, min: number, max: number, track?: string) => {
    const sl = new Slider({
      label, min, max, step: 1, track, def: defaultSplit()[key],
      format: key.endsWith('Hue') ? (v) => `${Math.round(v)}°` : undefined,
      get: () => app.state.split[key],
      set: (v, live) => app.update((s) => (s.split[key] = v), '分離色調', live),
    });
    sliders.push(sl);
    return sl.el;
  };
  const splitSec = new Section({
    title: '分離色調', key: 'adj-split',
    modified: () => sectionModified(app.state, 'split'),
    disabled: { get: () => !!app.state.disabled.split, toggle: () => app.update((s) => (s.disabled.split = !s.disabled.split), '分離色調開關') },
    reset: () => app.update((s) => (s.split = defaultSplit()), '重設分離色調'),
  },
  h('div.sub', '亮部'), split('highlightHue', '色相', 0, 360, rainbow), split('highlightSat', '飽和度', 0, 100),
  h('div.sub', '陰影'), split('shadowHue', '色相', 0, 360, rainbow), split('shadowSat', '飽和度', 0, 100),
  split('balance', '平衡', -100, 100));
  sections.push(splitSec);

  const el = h('div',
    flatSection('光線', auto, ...BASIC_DEFS.light.map(basic)),
    flatSection('色彩', null, ...BASIC_DEFS.color.map(basic)),
    flatSection('質感', null, ...BASIC_DEFS.detail.map(basic)),
    curveSec.el, hslSec.el, splitSec.el,
  );

  const reset = h('button.btn.ghost', { type: 'button' }, '全部重設');
  reset.addEventListener('click', () => app.update((s) => {
    s.basic = defaultBasic(); s.curves = defaultCurves(); s.hsl = defaultHsl(); s.split = defaultSplit(); s.disabled = {};
  }, '全部重設'));
  const save = h('button.btn', { type: 'button' }, '存成預設');
  save.addEventListener('click', async () => {
    const name = await ask('存成預設', '名稱', '我的預設');
    if (!name) return;
    const list = loadUserPresets();
    list.unshift({ id: uid(), name, builtin: false, look: extractLook(app.state) });
    saveUserPresets(list);
    toast(`已存成預設「${name}」`);
  });

  const quick = mobileQuick(app);

  return {
    el,
    foot: [reset, save],
    quick: quick.el,
    refresh(live) {
      sliders.forEach((s) => s.refresh());
      hslSliders.forEach((x) => x.sl.refresh());
      if (!live) curve.refresh();
      sections.forEach((s) => s.refresh());
      quick.refresh();
    },
  };
}

/** 手機：膠囊列 + 大數值 + 刻度尺 */
function mobileQuick(app: App) {
  const defs = [...BASIC_DEFS.light, ...BASIC_DEFS.color, ...BASIC_DEFS.detail];
  let cur = defs[0];
  const val = h('b');
  const label = h('span');
  const chips = h('div.chips');
  const ruler = new Ruler({
    get: () => ({ v: app.state.basic[cur.key], min: cur.min, max: cur.max, step: cur.step, def: 0 }),
    set: (v, live) => { app.update((s) => (s.basic[cur.key] = v), cur.label, live); paint(); },
  });
  const btns = defs.map((d) => {
    const b = h('button.chip', { type: 'button' }, d.label);
    b.addEventListener('click', () => { cur = d; paint(); ruler.draw(); });
    chips.append(b);
    return b;
  });
  const paint = () => {
    btns.forEach((b, i) => b.classList.toggle('on', defs[i] === cur));
    label.textContent = cur.label;
    const v = app.state.basic[cur.key];
    val.textContent = cur.fmt ? cur.fmt(v) : signed(v);
  };
  const el = h('div', chips, h('div.quick-val', label, val), ruler.el, h('div.ruler-hint', '左右滑動調整 · 點兩下歸零'));
  paint();
  return { el, refresh: () => { paint(); ruler.draw(); } };
}

/** 依直方圖自動：把中間調拉到中灰、把白點黑點撐開 */
function autoTone(app: App) {
  const s0 = structuredClone(app.state);
  s0.basic = defaultBasic();
  s0.film.enabled = false;
  const img = app.renderer.renderVariant(s0, 320);
  if (!img) return;
  const L: number[] = [];
  for (let i = 0; i < img.data.length; i += 4) L.push((img.data[i] * 0.2126 + img.data[i + 1] * 0.7152 + img.data[i + 2] * 0.0722) / 255);
  L.sort((a, b) => a - b);
  const q = (p: number) => L[Math.min(L.length - 1, Math.floor(p * L.length))];
  const lin = (p: number) => (p <= 0.04045 ? p / 12.92 : ((p + 0.055) / 1.055) ** 2.4);
  const med = lin(q(0.5));
  const exposure = Math.max(-2, Math.min(2, Math.log2(0.16 / Math.max(med, 1e-3)) * 0.7));
  const hi = q(0.995), lo = q(0.005);
  app.update((s) => {
    s.basic.exposure = Math.round(exposure * 100) / 100;
    s.basic.whites = Math.round(Math.max(-40, Math.min(40, (0.97 - hi) * 160)));
    s.basic.blacks = Math.round(Math.max(-40, Math.min(40, (0.02 - lo) * 300)));
    s.basic.highlights = hi > 0.98 ? -30 : -10;
    s.basic.shadows = lo < 0.03 ? 20 : 8;
    s.basic.vibrance = Math.max(s.basic.vibrance, 10);
  }, '自動');
  void icons;
}
