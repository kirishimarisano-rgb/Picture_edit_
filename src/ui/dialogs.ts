import { outputSize } from '../core/geometry';
import type { App } from './app';
import { h } from './dom';
import { icons } from './icons';
import { Slider } from './slider';
import { seg } from './widgets';

let toastHost: HTMLDivElement | null = null;
export function toast(msg: string, err = false) {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div.toast', { class: err ? 'err' : '' }, msg);
  toastHost.append(t);
  setTimeout(() => { t.style.transition = 'opacity 200ms'; t.style.opacity = '0'; }, err ? 4200 : 2400);
  setTimeout(() => t.remove(), err ? 4500 : 2700);
}

export function modal(title: string, body: HTMLElement, foot: HTMLElement[] = [], wide = false) {
  const close = () => { veil.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const x = h('button.ib', { type: 'button', 'aria-label': '關閉', html: icons.close() });
  x.addEventListener('click', close);
  const box = h('div.modal', { class: wide ? 'wide' : '', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), x),
    h('div.modal-body', body),
    foot.length ? h('div.modal-foot', ...foot) : null,
  );
  const veil = h('div.modal-veil', box);
  veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(veil);
  setTimeout(() => (box.querySelector('input,button.primary') as HTMLElement | null)?.focus(), 30);
  return { close, box };
}

/** 輸入名稱 */
export function ask(title: string, label: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input.input', { type: 'text', value });
    const ok = h('button.btn.primary', { type: 'button' }, '儲存');
    const cancel = h('button.btn.ghost', { type: 'button' }, '取消');
    const m = modal(title, h('div.field', h('label', label), input), [cancel, ok]);
    const done = (v: string | null) => { m.close(); resolve(v); };
    ok.addEventListener('click', () => done(input.value.trim() || value));
    cancel.addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(input.value.trim() || value); if (e.key === 'Escape') done(null); });
    setTimeout(() => input.select(), 40);
  });
}

const KEYS: [string, [string, string][]][] = [
  ['檢視', [['適合畫面 / 100%', 'Z'], ['縮放', 'Ctrl + / −'], ['適合畫面', 'Ctrl 0'], ['平移', 'Space 拖曳'], ['前後對比分割線', 'Y'], ['按住看原圖', '\\'], ['隱藏右面板', 'Tab'], ['全螢幕檢視', 'F']]],
  ['工具', [['調整', 'A'], ['裁切與拉直', 'R'], ['局部遮罩', 'M'], ['修補', 'J'], ['底片模擬', 'N'], ['預設集與快照', 'P'], ['歷史紀錄', 'H']]],
  ['編輯', [['復原', 'Ctrl Z'], ['重做', 'Ctrl ⇧ Z'], ['複製設定', 'Ctrl ⇧ C'], ['貼上設定', 'Ctrl ⇧ V'], ['匯出', 'Ctrl E'], ['開啟照片', 'Ctrl O']]],
  ['滑桿', [['歸零', '雙擊'], ['微調', '⇧ 拖曳'], ['逐格', '← →'], ['十格', '⇧ ← →'], ['輸入數值', '點數字']]],
  ['裁切 / 遮罩 / 修補', [['完成裁切', 'Enter'], ['看遮罩範圍', '按住 Alt'], ['筆刷大小', '[ ]'], ['擦除', '按住 Alt 塗抹'], ['刪除選取', 'Delete'], ['新增筆刷 / 線性 / 徑向', 'B  G  O']]],
];

export function shortcutsDialog() {
  const grid = h('div.keys');
  for (const [group, items] of KEYS) {
    grid.append(h('h4', group));
    for (const [label, key] of items) grid.append(h('div.k', h('span', label), h('span', ...key.split('  ').map((k) => h('kbd', k)))));
  }
  modal('快捷鍵', grid, [], true);
}

export function exportDialog(app: App, batch: boolean) {
  const docs = batch ? (app.selected.size > 1 ? app.selectedDocs() : app.docs) : [app.doc!];
  let mime = 'image/jpeg';
  let quality = 90;
  let size: 'full' | '4096' | '2048' | '1080' | 'custom' = 'full';
  let custom = 3000;
  const suffix = h('input.input', { type: 'text', value: '-edit' });
  const fmt = seg([
    { value: 'image/jpeg', label: 'JPEG' },
    { value: 'image/png', label: 'PNG' },
    { value: 'image/webp', label: 'WebP' },
  ], () => mime, (v) => { mime = v; update(); });
  const q = new Slider({ label: '品質', min: 40, max: 100, def: 90, get: () => quality, set: (v) => { quality = v; update(); } });
  const sz = seg([
    { value: 'full', label: '原尺寸' },
    { value: '4096', label: '4096' },
    { value: '2048', label: '2048' },
    { value: '1080', label: '1080' },
    { value: 'custom', label: '自訂' },
  ], () => size, (v) => { size = v; update(); });
  const customIn = h('input.input', { type: 'number', min: '64', max: '16384', value: String(custom) });
  customIn.addEventListener('input', () => { custom = Math.max(64, +customIn.value || 3000); update(); });
  const customRow = h('div.field', h('label', '長邊（px）'), customIn);
  const summary = h('div.export-summary');
  const bar = h('div');
  const progress = h('div.progress', bar);
  progress.hidden = true;
  const long = () => (size === 'full' ? null : size === 'custom' ? custom : +size);
  const update = () => {
    q.el.style.display = mime === 'image/png' ? 'none' : '';
    customRow.style.display = size === 'custom' ? '' : 'none';
    const d = docs[0];
    const [w, hh] = outputSize(d.w, d.h, d.state.geometry);
    const L = long();
    const k = L ? Math.min(1, L / Math.max(w, hh)) : 1;
    summary.textContent = docs.length > 1
      ? `${docs.length} 張照片 · 長邊 ${L ?? '原尺寸'}`
      : `${Math.round(w * k)} × ${Math.round(hh * k)} px · ${((w * k * hh * k) / 1e6).toFixed(1)} MP`;
  };
  const body = h('div',
    h('div.field', h('div.lbl', '格式'), fmt.el),
    q.el,
    h('div.field', h('div.lbl', '尺寸'), sz.el),
    customRow,
    h('div.field', h('label', '檔名後綴'), suffix),
    summary,
    progress,
  );
  const go = h('button.btn.primary', { type: 'button' }, docs.length > 1 ? `匯出 ${docs.length} 張` : '匯出');
  const cancel = h('button.btn.ghost', { type: 'button' }, '取消');
  const m = modal(docs.length > 1 ? '批次匯出' : '匯出', body, [cancel, go]);
  cancel.addEventListener('click', () => m.close());
  go.addEventListener('click', async () => {
    go.disabled = true;
    progress.hidden = false;
    try {
      let i = 0;
      for (const d of docs) {
        await app.exportDoc(d, { mime, quality: quality / 100, long: long(), suffix: suffix.value });
        i++;
        bar.style.width = `${(i / docs.length) * 100}%`;
        await new Promise((r) => setTimeout(r, 120));
      }
      toast(docs.length > 1 ? `已匯出 ${docs.length} 張照片` : '已匯出');
      m.close();
    } catch (err) {
      toast(`匯出失敗：${(err as Error).message}`, true);
      go.disabled = false;
    }
  });
  update();
}
