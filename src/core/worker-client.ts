import type { Exif } from './exif';
import WorkerCtor from './worker?worker&inline';

export interface Decoded {
  bitmap: ImageBitmap;
  thumb: ImageBitmap;
  w: number;
  h: number;
  exif: Exif;
}

/** 以 Promise 包裝的 Worker 呼叫 */
export class Analysis {
  private w: Worker;
  private seq = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();

  constructor() {
    this.w = new WorkerCtor();
    this.w.onmessage = (e: MessageEvent<{ seq: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(e.data.seq);
      if (!p) return;
      this.pending.delete(e.data.seq);
      if (e.data.ok) p.res(e.data.result);
      else p.rej(new Error(e.data.error));
    };
  }

  private call<T>(req: object, transfer: Transferable[] = []): Promise<T> {
    const seq = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.pending.set(seq, { res: res as (v: unknown) => void, rej });
      this.w.postMessage({ seq, req }, transfer);
    });
  }

  decode(id: string, file: Blob, maxSize: number) {
    return this.call<Decoded>({ type: 'decode', id, file, maxSize });
  }
  tilt(id: string) {
    return this.call<number>({ type: 'tilt', id });
  }
  healSource(id: string, x: number, y: number, r: number) {
    return this.call<[number, number]>({ type: 'heal', id, x, y, r });
  }
  encode(data: Uint8Array, w: number, h: number, mime: string, quality: number) {
    return this.call<Blob>({ type: 'encode', data, w, h, mime, quality }, [data.buffer]);
  }
  release(id: string) {
    return this.call<boolean>({ type: 'release', id });
  }
}
