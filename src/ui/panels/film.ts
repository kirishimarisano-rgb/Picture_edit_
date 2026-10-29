import { toImageData } from '../../core/gl/renderer';
import { BUILTIN_STOCKS, loadUserStocks, saveUserStocks, type FilmStock } from '../../core/film';
import { defaultFilm, uid, type Film } from '../../core/state';
import type { App, Pane } from '../app';
import { h, signed } from '../dom';
import { icons } from '../icons';
import { Slider } from '../slider';
import { FilmGraph, Section, seg, toggle } from '../widgets';
import { ask, toast } from '../dialogs';

const MONO_FILTERS: { value: string; label: string; w: [number, number, number] }[] = [
  { value: 'none', label: '無', w: [0.3, 0.59, 0.11] },
  { value: 'yellow', label: '黃', w: [0.38, 0.55, 0.07] },
  { value: 'orange', label: '橙', w: [0.5, 0.45, 0.05] },
  { value: 'red', label: '紅', w: [0.72, 0.26, 0.02] },
  { value: 'green', label: '綠', w: [0.2, 0.72, 0.08] },
];

export function filmPane(app: App): Pane {
  const sliders: Slider[] = [];
  const sections: Section[] = [];
  const F = () => app.state.film;
  const setF = (patch: Partial<Film>, label: string, live: boolean) =>
    app.update((s) => {
      Object.assign(s.film, patch);
      if (!s.film.enabled && Object.keys(patch).length) s.film.enabled = true;
    }, label, live);

  const sl = (key: keyof Film, label: string, min: number, max: number, step = 1, fmt?: (v: number) => string) => {
    const x = new Slider({
      label, min, max, step, def: defaultFilm()[key] as number, format: fmt,
      get: () => F()[key] as number,
      set: (v, live) => setF({ [key]: v } as Partial<Film>, `底片：${label}`, live),
    });
    sliders.push(x);
    return x.el;
  };
  const layer = (i: number, label: string, color: string) => {
    const x = new Slider({
      label, min: -0.5, max: 0.5, step: 0.01, format: (v) => signed(v, 2),
      track: `linear-gradient(90deg,#3a3a3a,${color})`,
      get: () => F().layerOffset[i],
      set: (v, live) => { const o = [...F().layerOffset] as [number, number, number]; o[i] = v; setF({ layerOffset: o }, '底片：感光層', live); },
    });
    sliders.push(x);
    return x.el;
  };

  // ── 配方格 ──
  let users = loadUserStocks();
  const grid = h('div.stocks', { role: 'listbox', 'aria-label': '底片配方' });
  const note = h('div.stock-note');
  const thumbs = new Map<string, HTMLCanvasElement>();
  let thumbKey = '';
  const all = () => [...BUILTIN_STOCKS, ...users];
  const buildGrid = () => {
    grid.replaceChildren(...all().map((st) => {
      let c = thumbs.get(st.id);
      if (!c) { c = h('canvas'); thumbs.set(st.id, c); }
      const pv = h('div.pv', c, h('span.iso', String(st.params.iso)));
      if (!st.builtin) {
        const del = h('span.del', { role: 'button', title: '刪除這個配方', html: icons.close(12) });
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          users = users.filter((u) => u.id !== st.id);
          saveUserStocks(users);
          buildGrid();
          refresh();
        });
        pv.append(del);
      }
      const b = h('button.stock', { type: 'button', role: 'option', 'data-id': st.id, title: st.note }, pv, h('span.nm', st.name));
      b.addEventListener('click', () => {
        app.update((s) => { s.film = { ...structuredClone(st.params), enabled: true, stock: st.id, border: s.film.border }; }, `底片：${st.name}`);
      });
      return b;
    }));
  };
  buildGrid();

  const renderThumbs = () => {
    const doc = app.doc;
    if (!doc) return;
    const base = structuredClone(app.state);
    const key = doc.id + JSON.stringify({ ...base, film: null, masks: base.masks.length }) + users.length;
    if (key === thumbKey) return;
    thumbKey = key;
    const list = all();
    let i = 0;
    const step = () => {
      if (thumbKey !== key || app.doc !== doc || i >= list.length) return;
      const st = list[i++];
      const s = structuredClone(base);
      s.film = { ...structuredClone(st.params), enabled: true, border: false };
      const img = app.renderer.renderVariant(s, 180);
      const c = thumbs.get(st.id);
      if (img && c) {
        c.width = img.w;
        c.height = img.h;
        c.getContext('2d')!.putImageData(toImageData(img), 0, 0);
      }
      setTimeout(step, 16);
    };
    step();
  };
  let thumbTimer = 0;
  const scheduleThumbs = (delay = 350) => { clearTimeout(thumbTimer); thumbTimer = window.setTimeout(renderThumbs, delay); };

  const enable = toggle('套用底片', () => F().enabled, (v) => app.update((s) => (s.film.enabled = v), v ? '底片開啟' : '底片關閉'));
  const head = h('div.pane-title', h('h2', '底片配方'), h('span.meta'));
  const meta = head.querySelector('.meta') as HTMLElement;

  const graph = new FilmGraph(F, (patch, live) => setF(patch, '底片：特性曲線', live));

  const monoSeg = seg(MONO_FILTERS.map((m) => ({ value: m.value, label: m.label })), () => {
    const w = F().monoFilter;
    return MONO_FILTERS.find((m) => m.w.every((v, i) => Math.abs(v - w[i]) < 0.02))?.value ?? 'none';
  }, (v) => setF({ monoFilter: [...MONO_FILTERS.find((m) => m.value === v)!.w] as [number, number, number] }, '底片：黑白濾鏡', false));
  const mono = toggle('黑白底片', () => F().mono, (v) => setF({ mono: v }, '底片：黑白', false));
  const monoRow = h('div', mono.el, h('div.sub', '黑白濾鏡（拍攝時加在鏡頭前的色濾鏡）'), monoSeg.el);

  const curveSec = new Section({ title: '特性曲線', key: 'film-curve', open: true },
    graph.el,
    h('div.graph-legend', h('span', '趾部 toe'), h('span', '肩部 shoulder')),
    sl('filmExposure', '底片曝光', -2, 2, 0.01, (v) => signed(v, 2)),
    sl('gamma', '反差（γ）', 0.4, 2, 0.01, (v) => v.toFixed(2)),
    sl('toe', '趾部', 0, 100),
    sl('shoulder', '肩部', 0, 100),
    sl('fade', '片基霧度', 0, 100),
  );
  const colorSec = new Section({ title: '感光層與色彩', key: 'film-color' },
    sl('crosstalk', '層間串擾', 0, 100),
    sl('saturation', '色彩飽和', -100, 100),
    layer(0, '紅層曝光', '#d0584a'), layer(1, '綠層曝光', '#5aae66'), layer(2, '藍層曝光', '#5a82d6'),
    monoRow,
  );
  const grainSec = new Section({ title: '顆粒', key: 'film-grain', open: true },
    sl('iso', '感光度 ISO', 25, 3200, 25),
    sl('grain', '顆粒量', 0, 100),
    sl('grainSize', '顆粒大小', 0, 100),
    sl('grainColor', '彩色顆粒', 0, 100),
    h('div.sub', '顆粒依亮度變化：暗部與中間調較明顯；放大到 100% 看最準（Z）'),
  );
  const seedBtn = h('button.btn.sm', { type: 'button', html: icons.dice(14) + '<span>換一個</span>' });
  seedBtn.addEventListener('click', () => setF({ leakSeed: Math.random(), leak: Math.max(F().leak, 30) }, '底片：漏光', false));
  const border = toggle('片邊', () => F().border, (v) => setF({ border: v }, '底片：片邊', false));
  const lightSec = new Section({ title: '光學與特效', key: 'film-light' },
    sl('halation', '高光暈染', 0, 100),
    sl('halationRadius', '暈染半徑', 0, 100),
    sl('bloom', '柔光', 0, 100),
    sl('vignette', '暗角', -100, 100),
    sl('vignetteSize', '暗角範圍', 0, 100),
    sl('leak', '漏光', 0, 100),
    h('div', { style: 'display:flex;justify-content:flex-end;margin:-4px 0 6px' }, seedBtn),
    border.el,
  );
  sections.push(curveSec, colorSec, grainSec, lightSec);
  const strength = new Slider({
    label: '強度', min: 0, max: 100, step: 1, def: 100, format: (v) => `${Math.round(v)}%`,
    get: () => F().strength,
    set: (v, live) => setF({ strength: v }, '底片：強度', live),
  });
  sliders.push(strength);

  const el = h('div',
    head, grid, note,
    h('div', { style: 'padding:0 16px 6px' }, enable.el, strength.el),
    ...sections.map((s) => s.el),
  );

  const save = h('button.btn', { type: 'button' }, '存成我的配方');
  save.addEventListener('click', async () => {
    const name = await ask('存成我的配方', '名稱', `${(all().find((s) => s.id === F().stock)?.name ?? '自訂').split(' ')[0]} 改`);
    if (!name) return;
    const st: FilmStock = { id: 'u-' + uid(), name, latin: name, note: '自訂配方', builtin: false, params: structuredClone({ ...F(), enabled: true }) };
    st.params.stock = st.id;
    users = [...users, st];
    saveUserStocks(users);
    buildGrid();
    thumbKey = '';
    scheduleThumbs(0);
    app.update((s) => (s.film.stock = st.id), `底片：${name}`);
    toast(`已存成配方「${name}」`);
  });
  const reset = h('button.btn.ghost', { type: 'button' }, '關閉底片');
  reset.addEventListener('click', () => app.update((s) => (s.film = defaultFilm()), '關閉底片'));

  const refresh = (live?: boolean) => {
    sliders.forEach((s) => s.refresh());
    enable.refresh(); mono.refresh(); monoSeg.refresh(); border.refresh();
    monoRow.querySelector('.seg')!.toggleAttribute('hidden', !F().mono);
    graph.refresh();
    sections.forEach((s) => s.refresh());
    const cur = F();
    grid.querySelectorAll<HTMLElement>('.stock').forEach((b) => {
      const on = cur.enabled && b.dataset.id === cur.stock;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    const st = all().find((s) => s.id === cur.stock);
    note.replaceChildren(...(cur.enabled && st ? [h('b', `${st.name}`), st.note] : [cur.enabled ? '自訂參數' : '選一種底片開始，所有參數都能再微調']));
    meta.textContent = `${BUILTIN_STOCKS.length} 內建${users.length ? ` · ${users.length} 自訂` : ''}`;
    if (!live) scheduleThumbs();
  };

  return {
    el,
    foot: [reset, save],
    refresh,
    show: () => scheduleThumbs(60),
  };
}
