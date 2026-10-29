import { BUILTIN_PRESETS, loadUserPresets, saveUserPresets, type Preset } from '../../core/presets';
import { deserialize, extractLook, serialize, uid } from '../../core/state';
import type { App, Pane } from '../app';
import { h } from '../dom';
import { icons } from '../icons';
import { ask, toast } from '../dialogs';

export function presetsPane(app: App): Pane {
  const presetList = h('div.list', { role: 'list' });
  const snapList = h('div.list', { role: 'list' });
  const targetNote = h('span.meta');

  const apply = (p: Preset) => {
    const targets = app.selected.size > 1 ? app.selectedDocs() : app.doc ? [app.doc] : [];
    app.applyLookTo(targets, p.look, `預設：${p.name}`);
    if (targets.length > 1) toast(`已套用「${p.name}」到 ${targets.length} 張照片`);
  };

  const renderPresets = () => {
    const users = loadUserPresets();
    const row = (p: Preset) => {
      const r = h('button.row', { type: 'button', role: 'listitem' }, h('span.ico', { html: icons.presets(16) }), h('span.grow', p.name));
      if (!p.builtin) {
        const del = h('button.ib', { type: 'button', 'aria-label': '刪除預設', html: icons.trash() });
        del.addEventListener('click', (e) => { e.stopPropagation(); saveUserPresets(users.filter((u) => u.id !== p.id)); renderPresets(); });
        r.append(h('span.acts', del));
      } else r.append(h('span.meta', '內建'));
      r.addEventListener('click', () => apply(p));
      return r;
    };
    presetList.replaceChildren(
      ...(users.length ? [h('div.sub', { style: 'padding:0 8px' }, '我的預設'), ...users.map(row)] : []),
      h('div.sub', { style: 'padding:0 8px;margin-top:8px' }, '內建'),
      ...BUILTIN_PRESETS.map(row),
    );
  };

  const renderSnaps = () => {
    const d = app.doc;
    if (!d || !d.snapshots.length) { snapList.replaceChildren(h('div.empty-note', '快照會記住這張照片目前的完整狀態（含裁切、遮罩），之後可以一鍵回來比較。')); return; }
    snapList.replaceChildren(...d.snapshots.map((sn) => {
      const del = h('button.ib', { type: 'button', 'aria-label': '刪除快照', html: icons.trash() });
      del.addEventListener('click', (e) => { e.stopPropagation(); d.snapshots = d.snapshots.filter((x) => x !== sn); renderSnaps(); });
      const r = h('button.row', { type: 'button' }, h('span.ico', { html: icons.camera(16) }), h('span.grow', sn.name),
        h('span.meta', new Date(sn.time).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })), h('span.acts', del));
      r.addEventListener('click', () => { app.replaceState(sn.state, `快照：${sn.name}`); toast(`已回到快照「${sn.name}」`); });
      return r;
    }));
  };

  const savePreset = h('button.btn', { type: 'button', html: icons.plus() + '<span>存目前設定為預設</span>' });
  savePreset.addEventListener('click', async () => {
    if (!app.doc) return;
    const name = await ask('存成預設', '名稱', '我的預設');
    if (!name) return;
    const list = loadUserPresets();
    list.unshift({ id: uid(), name, builtin: false, look: extractLook(app.state) });
    saveUserPresets(list);
    renderPresets();
    toast(`已存成預設「${name}」`);
  });
  const snap = h('button.btn', { type: 'button', html: icons.camera() + '<span>建立快照</span>' });
  snap.addEventListener('click', async () => {
    const d = app.doc;
    if (!d) return;
    const name = await ask('建立快照', '名稱', `快照 ${d.snapshots.length + 1}`);
    if (!name) return;
    d.snapshots.unshift({ id: uid(), name, state: structuredClone(d.state), time: Date.now() });
    renderSnaps();
  });

  const copy = h('button.btn', { type: 'button', html: icons.copy() + '<span>複製設定</span>' });
  copy.addEventListener('click', () => app.copySettings());
  const paste = h('button.btn', { type: 'button', html: icons.paste() + '<span>貼上設定</span>' });
  paste.addEventListener('click', () => app.pasteSettings());
  const dl = h('button.btn', { type: 'button', html: icons.download() + '<span>下載編輯紀錄</span>' });
  dl.addEventListener('click', () => {
    const d = app.doc;
    if (!d) return;
    const blob = new Blob([serialize(d.state)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: d.name.replace(/\.[^.]+$/, '') + '.edit.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  const ul = h('button.btn', { type: 'button', html: icons.upload() + '<span>載入編輯紀錄</span>' });
  const jsonIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  ul.addEventListener('click', () => jsonIn.click());
  jsonIn.addEventListener('change', async () => {
    const f = jsonIn.files?.[0];
    jsonIn.value = '';
    if (!f || !app.doc) return;
    try {
      app.replaceState(deserialize(await f.text()), '載入編輯紀錄');
      toast('已載入編輯紀錄');
    } catch {
      toast('這不是有效的編輯紀錄檔', true);
    }
  });

  const el = h('div',
    h('div.pane-title', h('h2', '預設集'), targetNote),
    h('div.add-row', savePreset),
    presetList,
    h('div.pane-title', { style: 'border-top:1px solid var(--line)' }, h('h2', '快照')),
    h('div.add-row', snap),
    snapList,
    h('div.pane-title', { style: 'border-top:1px solid var(--line)' }, h('h2', '設定')),
    h('div.add-row', copy, paste),
    h('div.add-row', dl, ul, jsonIn),
    h('div.hint', '編輯紀錄是一份 JSON：原圖不會被改動，帶著這份紀錄就能在任何時候重現結果。'),
  );

  return {
    el,
    refresh() {
      targetNote.textContent = app.selected.size > 1 ? `套用到選取的 ${app.selected.size} 張` : '';
      renderSnaps();
      paste.disabled = !app.clipboard;
    },
    show() { renderPresets(); },
  };
}
