import { clone, type EditState } from './state';

export interface HistoryEntry {
  label: string;
  state: EditState;
  time: number;
}

/**
 * 線性歷史：可跳回任一步；跳回後再做新動作，後面的分支會被丟掉（和 Lightroom 一樣）。
 */
export class History {
  entries: HistoryEntry[] = [];
  index = -1;
  private limit: number;

  constructor(initial: EditState, limit = 200) {
    this.limit = limit;
    this.push('開啟', initial);
  }

  get current(): EditState {
    return this.entries[this.index].state;
  }

  push(label: string, state: EditState) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ label, state: clone(state), time: Date.now() });
    if (this.entries.length > this.limit) this.entries.splice(1, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
  }

  /** 同一個動作連續觸發時（例如拖同一個滑桿）合併成一步 */
  replaceTop(label: string, state: EditState) {
    if (this.index <= 0 || this.index !== this.entries.length - 1 || this.entries[this.index].label !== label) {
      this.push(label, state);
      return;
    }
    this.entries[this.index] = { label, state: clone(state), time: Date.now() };
  }

  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.entries.length - 1;
  }

  undo(): EditState | null {
    if (!this.canUndo) return null;
    this.index--;
    return clone(this.current);
  }

  redo(): EditState | null {
    if (!this.canRedo) return null;
    this.index++;
    return clone(this.current);
  }

  jump(i: number): EditState {
    this.index = Math.max(0, Math.min(this.entries.length - 1, i));
    return clone(this.current);
  }
}
