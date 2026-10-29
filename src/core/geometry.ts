import type { Geometry } from './state';

/** 3×3 仿射矩陣，列優先：[a, b, c, d, e, f] 代表 x' = a x + b y + c、y' = d x + e y + f */
export type Affine = [number, number, number, number, number, number];

export const I: Affine = [1, 0, 0, 0, 1, 0];

export function mul(m: Affine, n: Affine): Affine {
  // 先套 n 再套 m
  return [
    m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
    m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5],
  ];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[4] - m[1] * m[3];
  const a = m[4] / det, b = -m[1] / det, d = -m[3] / det, e = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

const translate = (x: number, y: number): Affine => [1, 0, x, 0, 1, y];
const scale = (x: number, y: number): Affine => [x, 0, 0, 0, y, 0];
const rotate = (r: number): Affine => [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0];

/** 轉 90° 之後的畫框尺寸 */
export function orientedSize(w: number, h: number, g: Pick<Geometry, 'rot90'>): [number, number] {
  return g.rot90 % 2 ? [h, w] : [w, h];
}

/** 畫框像素 → 來源像素（只處理 90° 旋轉與翻轉） */
function orientToSource(w: number, h: number, g: Geometry): Affine {
  const [ow, oh] = orientedSize(w, h, g);
  // 先撤銷翻轉（在畫框座標）
  let m: Affine = mul(translate(g.flipH ? ow : 0, g.flipV ? oh : 0), scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1));
  // 再撤銷 k 次順時針旋轉：每次 (X, Y) → (Y, W_prev - X)
  let cw = ow, ch = oh;
  for (let i = 0; i < ((g.rot90 % 4) + 4) % 4; i++) {
    const step: Affine = [0, 1, 0, -1, 0, cw];
    m = mul(step, m);
    [cw, ch] = [ch, cw];
  }
  return m;
}

/** 畫框正規化座標（0..1，含拉直旋轉）→ 來源 uv */
export function frameToSource(w: number, h: number, g: Geometry): Affine {
  const [ow, oh] = orientedSize(w, h, g);
  const th = (g.angle * Math.PI) / 180;
  let m: Affine = scale(ow, oh); // 正規化 → 畫框像素
  m = mul(translate(-ow / 2, -oh / 2), m);
  m = mul(rotate(-th), m);
  m = mul(translate(ow / 2, oh / 2), m);
  m = mul(orientToSource(w, h, g), m);
  m = mul(scale(1 / w, 1 / h), m);
  return m;
}

/** 輸出 uv（裁切後 0..1）→ 來源 uv。ignoreCrop 用於裁切模式時看到整個畫框 */
export function outputToSource(w: number, h: number, g: Geometry, ignoreCrop = false): Affine {
  const c = ignoreCrop ? { x: 0, y: 0, w: 1, h: 1 } : g.crop;
  return mul(frameToSource(w, h, g), [c.w, 0, c.x, 0, c.h, c.y]);
}

export function outputSize(w: number, h: number, g: Geometry, ignoreCrop = false): [number, number] {
  const [ow, oh] = orientedSize(w, h, g);
  if (ignoreCrop) return [ow, oh];
  return [Math.max(1, Math.round(g.crop.w * ow)), Math.max(1, Math.round(g.crop.h * oh))];
}

/** 裁切框四角是否都落在（旋轉後的）影像裡 */
export function cropFits(w: number, h: number, g: Geometry, crop = g.crop): boolean {
  const m = frameToSource(w, h, g);
  const eps = 1e-6;
  for (const [x, y] of [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h]]) {
    const [u, v] = apply(m, x, y);
    if (u < -eps || v < -eps || u > 1 + eps || v > 1 + eps) return false;
  }
  return true;
}

/** 以裁切框中心等比縮小直到放得進影像（拉直時自動裁掉空白角落） */
export function fitCrop(w: number, h: number, g: Geometry): Geometry['crop'] {
  const c = g.crop;
  if (cropFits(w, h, g)) return c;
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  const at = (s: number) => ({ x: cx - (c.w * s) / 2, y: cy - (c.h * s) / 2, w: c.w * s, h: c.h * s });
  // 先試著把中心拉回畫框中央附近
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (cropFits(w, h, g, at(mid))) lo = mid; else hi = mid;
  }
  if (lo > 0.02) return at(lo);
  const centered = { ...g, crop: { x: 0.5 - c.w / 2, y: 0.5 - c.h / 2, w: c.w, h: c.h } };
  return fitCrop(w, h, centered);
}

/** 比例字串 → 畫框正規化座標中的 w/h 比（考慮畫框本身的長寬） */
export function aspectRatio(aspect: string, w: number, h: number, g: Geometry): number | null {
  const [ow, oh] = orientedSize(w, h, g);
  if (aspect === 'free') return null;
  if (aspect === 'original') return 1; // 正規化座標裡，原始比例 = 1:1
  const [a, b] = aspect.split(':').map(Number);
  if (!a || !b) return null;
  return (a / b) * (oh / ow);
}

/** 依比例產生最大的置中裁切框 */
export function cropForAspect(aspect: string, w: number, h: number, g: Geometry): Geometry['crop'] {
  const r = aspectRatio(aspect, w, h, g);
  let cw = 1, ch = 1;
  if (r !== null) {
    if (r > 1) ch = 1 / r; else cw = r;
  }
  const crop = { x: (1 - cw) / 2, y: (1 - ch) / 2, w: cw, h: ch };
  return fitCrop(w, h, { ...g, crop });
}
