/// <reference lib="webworker" />
// 重運算都在這裡：解碼、EXIF、縮圖、自動拉直、修復來源搜尋、編碼匯出。
import { detectTilt, findHealSource, toGray, type Gray } from './analysis';
import { parseExif } from './exif';

declare const self: DedicatedWorkerGlobalScope;

const ANALYSIS_LONG = 1024;
const grays = new Map<string, Gray>();

type Req =
  | { type: 'decode'; id: string; file: Blob; maxSize: number }
  | { type: 'tilt'; id: string }
  | { type: 'heal'; id: string; x: number; y: number; r: number }
  | { type: 'encode'; data: Uint8Array; w: number; h: number; mime: string; quality: number }
  | { type: 'release'; id: string };

function resized(bmp: ImageBitmap, long: number) {
  const k = Math.min(1, long / Math.max(bmp.width, bmp.height));
  return [Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k))] as const;
}

async function handle(req: Req): Promise<{ result: unknown; transfer?: Transferable[] }> {
  switch (req.type) {
    case 'decode': {
      const buf = await req.file.arrayBuffer();
      const exif = parseExif(buf);
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(req.file, { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'none' });
      } catch {
        throw new Error('這個瀏覽器無法解碼這個檔案（HEIC 目前只有 Safari 支援）');
      }
      if (Math.max(bmp.width, bmp.height) > req.maxSize) {
        const [w, h] = resized(bmp, req.maxSize);
        const big = bmp;
        bmp = await createImageBitmap(big, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        big.close();
      }
      const [aw, ah] = resized(bmp, ANALYSIS_LONG);
      const oc = new OffscreenCanvas(aw, ah);
      const ctx = oc.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, aw, ah);
      grays.set(req.id, toGray(ctx.getImageData(0, 0, aw, ah).data, aw, ah));
      const [tw, th] = resized(bmp, 320);
      const thumb = await createImageBitmap(bmp, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      return { result: { bitmap: bmp, thumb, w: bmp.width, h: bmp.height, exif }, transfer: [bmp, thumb] };
    }
    case 'tilt': {
      const g = grays.get(req.id);
      return { result: g ? detectTilt(g) : 0 };
    }
    case 'heal': {
      const g = grays.get(req.id);
      if (!g) return { result: [req.x + req.r * 2.5, req.y] };
      const long = Math.max(g.w, g.h);
      const [sx, sy] = findHealSource(g, req.x * g.w, req.y * g.h, req.r * long);
      return { result: [sx / g.w, sy / g.h] };
    }
    case 'encode': {
      const oc = new OffscreenCanvas(req.w, req.h);
      const ctx = oc.getContext('2d')!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(req.data.buffer as ArrayBuffer, req.data.byteOffset, req.data.byteLength), req.w, req.h), 0, 0);
      const blob = await oc.convertToBlob({ type: req.mime, quality: req.quality });
      return { result: blob };
    }
    case 'release':
      grays.delete(req.id);
      return { result: true };
  }
}

self.onmessage = async (e: MessageEvent<{ seq: number; req: Req }>) => {
  const { seq, req } = e.data;
  try {
    const { result, transfer } = await handle(req);
    self.postMessage({ seq, ok: true, result }, { transfer: transfer ?? [] });
  } catch (err) {
    self.postMessage({ seq, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
