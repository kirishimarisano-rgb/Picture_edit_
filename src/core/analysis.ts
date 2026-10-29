// 在 Worker 裡跑的影像分析：純函式、不碰 DOM，方便單元測試。

export interface Gray {
  data: Float32Array;
  w: number;
  h: number;
}

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) data[j] = (rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722) / 255;
  return { data, w, h };
}

/**
 * 自動拉直：統計強邊緣的方向，找出最接近水平（或垂直）的主要方向偏了幾度。
 * 回傳要套用的拉直角度（度）；畫面上的線會因此變水平。
 */
export function detectTilt(g: Gray, maxDeg = 20): number {
  const { data, w, h } = g;
  const binsPerDeg = 10;
  const nb = maxDeg * 2 * binsPerDeg + 1;
  const hist = new Float64Array(nb);
  const mags: number[] = [];
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = data[i - w - 1], b = data[i - w], c = data[i - w + 1];
      const d = data[i - 1], f = data[i + 1];
      const gg = data[i + w - 1], hh = data[i + w], ii = data[i + w + 1];
      gx[i] = c + 2 * f + ii - a - 2 * d - gg;
      gy[i] = gg + 2 * hh + ii - a - 2 * b - c;
      if ((x + y) % 7 === 0) mags.push(Math.hypot(gx[i], gy[i]));
    }
  mags.sort((p, q) => p - q);
  const thr = Math.max(0.08, mags[Math.floor(mags.length * 0.9)] ?? 0.1);
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const m = Math.hypot(gx[i], gy[i]);
      if (m < thr) continue;
      // 邊緣方向 = 梯度方向 + 90°，折到 (-90, 90]
      let ang = (Math.atan2(gy[i], gx[i]) * 180) / Math.PI + 90;
      while (ang > 90) ang -= 180;
      while (ang <= -90) ang += 180;
      let dev: number, wgt: number;
      if (Math.abs(ang) <= maxDeg) { dev = ang; wgt = 1; }
      else if (Math.abs(Math.abs(ang) - 90) <= maxDeg) { dev = ang > 0 ? ang - 90 : ang + 90; wgt = 0.6; }
      else continue;
      const bin = Math.round((dev + maxDeg) * binsPerDeg);
      hist[bin] += m * m * wgt;
    }
  // 平滑後找峰值
  const sm = new Float64Array(nb);
  for (let i = 0; i < nb; i++)
    for (let k = -6; k <= 6; k++) {
      const j = i + k;
      if (j >= 0 && j < nb) sm[i] += hist[j] * Math.exp(-(k * k) / 18);
    }
  let best = (nb - 1) / 2;
  for (let i = 0; i < nb; i++) if (sm[i] > sm[best]) best = i;
  // 拋物線內插求次 bin 精度
  let peak = best;
  if (best > 0 && best < nb - 1) {
    const a = sm[best - 1], b = sm[best], c = sm[best + 1];
    const den = a - 2 * b + c;
    if (den !== 0) peak = best + (0.5 * (a - c)) / den;
  }
  const dev = peak / binsPerDeg - maxDeg;
  return Math.abs(dev) < 0.05 ? 0 : -dev;
}

/** 污點修復：在周圍找一塊「外圈紋理最像」的地方當來源（座標皆為灰階圖像素） */
export function findHealSource(g: Gray, x: number, y: number, r: number): [number, number] {
  const { data, w, h } = g;
  const ring: [number, number][] = [];
  const n = 24;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    for (const rr of [1.15, 1.45, 1.8]) ring.push([Math.cos(a) * r * rr, Math.sin(a) * r * rr]);
  }
  const at = (px: number, py: number) => {
    const ix = Math.max(0, Math.min(w - 1, Math.round(px)));
    const iy = Math.max(0, Math.min(h - 1, Math.round(py)));
    return data[iy * w + ix];
  };
  const target = ring.map(([dx, dy]) => at(x + dx, y + dy));
  const tMean = target.reduce((s, v) => s + v, 0) / target.length;
  let best: [number, number] = [x + r * 2.5, y];
  let bestScore = Infinity;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    for (const dist of [2.3, 3, 4, 5.5]) {
      const cx = x + Math.cos(a) * r * dist, cy = y + Math.sin(a) * r * dist;
      if (cx - r * 1.9 < 0 || cy - r * 1.9 < 0 || cx + r * 1.9 >= w || cy + r * 1.9 >= h) continue;
      const vals = ring.map(([dx, dy]) => at(cx + dx, cy + dy));
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      let ssd = 0;
      // 比的是「去掉平均之後的紋理」＋一點點亮度差，修復時亮度會再被校正
      for (let i = 0; i < vals.length; i++) ssd += (vals[i] - mean - (target[i] - tMean)) ** 2;
      // 中心區也不要太花（避免把另一個污點搬過來）
      let inner = 0;
      for (const [dx, dy] of ring) inner += Math.abs(at(cx + dx * 0.5, cy + dy * 0.5) - mean);
      const score = ssd / vals.length + 0.15 * (mean - tMean) ** 2 + 0.02 * (inner / ring.length) + 0.0004 * dist;
      if (score < bestScore) {
        bestScore = score;
        best = [cx, cy];
      }
    }
  }
  return best;
}
