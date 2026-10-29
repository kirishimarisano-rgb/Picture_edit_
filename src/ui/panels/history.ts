import type { App, Pane } from '../app';
import { h } from '../dom';

export function historyPane(app: App): Pane {
  const list = h('div.list', { role: 'listbox', 'aria-label': '歷史紀錄' });
  const meta = h('span.meta');
  const el = h('div', h('div.pane-title', h('h2', '歷史紀錄'), meta), list, h('div.hint', '點任何一步就回到那時候；回去之後再做新的調整，後面的步驟會被取代。'));
  let key = '';
  return {
    el,
    refresh() {
      const hst = app.doc?.history;
      if (!hst) { list.replaceChildren(h('div.empty-note', '開啟照片後，每一步調整都會記在這裡。')); return; }
      const k = hst.entries.length + ':' + hst.index + ':' + hst.entries[hst.entries.length - 1]?.time;
      if (k === key) return;
      key = k;
      meta.textContent = `${hst.entries.length} 步`;
      const rows = hst.entries.map((e, i) => {
        const r = h('button.row', { type: 'button', role: 'option', 'aria-selected': String(i === hst.index), class: i === hst.index ? 'on' : i > hst.index ? 'future' : '' },
          h('span.grow', e.label), h('span.meta', new Date(e.time).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
        r.addEventListener('click', () => app.jumpHistory(i));
        return r;
      });
      list.replaceChildren(...rows.reverse());
    },
  };
}
