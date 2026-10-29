import type { CurvePoint, Curves } from './state';

export const LUT_SIZE = 256;

/** 單調三次 Hermite 樣條（Fritsch–Carlson），不會在控制點之間過衝 */
export function evalCurve(points: CurvePoint[], n = LUT_SIZE): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(n);
  if (pts.length < 2) {
    for (let i = 0; i < n; i++) out[i] = i / (n - 1);
    return out;
  }
  const k = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < k - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m: number[] = new Array(k);
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= xs[0]) { out[j] = ys[0]; continue; }
    if (x >= xs[k - 1]) { out[j] = ys[k - 1]; continue; }
    while (seg < k - 2 && x > xs[seg + 1]) seg++;
    const h = xs[seg + 1] - xs[seg];
    const t = (x - xs[seg]) / h;
    const t2 = t * t, t3 = t2 * t;
    out[j] =
      (2 * t3 - 3 * t2 + 1) * ys[seg] +
      (t3 - 2 * t2 + t) * h * m[seg] +
      (-2 * t3 + 3 * t2) * ys[seg + 1] +
      (t3 - t2) * h * m[seg + 1];
    out[j] = Math.min(1, Math.max(0, out[j]));
  }
  return out;
}

function sample(lut: Float32Array, x: number): number {
  const f = Math.min(1, Math.max(0, x)) * (lut.length - 1);
  const i = Math.floor(f);
  const j = Math.min(lut.length - 1, i + 1);
  return lut[i] + (lut[j] - lut[i]) * (f - i);
}

/** 組合成一張 RGBA LUT：每通道 = 通道曲線(主曲線(x))，A 為主曲線本身 */
export function buildCurveLut(c: Curves, n = LUT_SIZE): Float32Array {
  const master = evalCurve(c.rgb, n);
  const r = evalCurve(c.r, n), g = evalCurve(c.g, n), b = evalCurve(c.b, n);
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const m = master[i];
    out[i * 4] = sample(r, m);
    out[i * 4 + 1] = sample(g, m);
    out[i * 4 + 2] = sample(b, m);
    out[i * 4 + 3] = m;
  }
  return out;
}
