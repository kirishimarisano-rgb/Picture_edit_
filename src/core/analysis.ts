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
 * 自動拉直：限定方向的霍夫轉換。
 * 對每個候選傾角 δ，只讓「梯度方向符合」的邊緣像素投票到對應的直線上，
 * 再以 Σ票數² 評分（長而直的線，像地平線、建築、樹幹，分數會遠高於零散的紋理）。
 * 回傳要套用的拉直角度（度）；畫面上的線會因此變水平／垂直。
 */
export function detectTilt(input: Gray, maxDeg = 15, debug?: { ratio?: number }): number {
  const { data, w, h } = input;
  const px: number[] = [], py: number[] = [], pa: number[] = [], pm: number[] = [];
  const mags: number[] = [];
  const gxA = new Float32Array(w * h), gyA = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = data[i - w - 1], b = data[i - w], c = data[i - w + 1];
      const d = data[i - 1], f = data[i + 1];
      const gg = data[i + w - 1], hh = data[i + w], ii = data[i + w + 1];
      gxA[i] = c + 2 * f + ii - a - 2 * d - gg;
      gyA[i] = gg + 2 * hh + ii - a - 2 * b - c;
      if ((x * 7 + y * 3) % 11 === 0) mags.push(Math.hypot(gxA[i], gyA[i]));
    }
  mags.sort((p, q) => p - q);
  const thr = Math.max(0.06, mags[Math.floor(mags.length * 0.9)] ?? 0.1);
  const margin = Math.round(Math.min(w, h) * 0.02) + 2;
  for (let y = margin; y < h - margin; y++)
    for (let x = margin; x < w - margin; x++) {
      const i = y * w + x;
      const m = Math.hypot(gxA[i], gyA[i]);
      if (m < thr) continue;
      // 簡易非極大值抑制：沿梯度方向比較鄰居，讓邊緣變細
      const ux = gxA[i] / m, uy = gyA[i] / m;
      const j1 = Math.round(y + uy) * w + Math.round(x + ux), j2 = Math.round(y - uy) * w + Math.round(x - ux);
      if (Math.hypot(gxA[j1], gyA[j1]) > m || Math.hypot(gxA[j2], gyA[j2]) > m) continue;
      let ang = (Math.atan2(gyA[i], gxA[i]) * 180) / Math.PI; // 梯度方向
      ang = ((ang % 180) + 180) % 180; // 0..180
      px.push(x); py.push(y); pa.push(ang); pm.push(Math.min(m, thr * 3));
    }
  const tol = 5;
  const step = 0.1;
  const n = Math.round((2 * maxDeg) / step) + 1;
  const score = new Float64Array(n);
  const diag = Math.ceil(Math.hypot(w, h));
  const acc = new Float32Array(diag * 2 + 4);
  const angDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };
  for (let k = 0; k < n; k++) {
    const dDeg = -maxDeg + k * step;
    const dr = (dDeg * Math.PI) / 180;
    const sn = Math.sin(dr), cs = Math.cos(dr);
    for (const fam of [0, 1]) {
      acc.fill(0);
      const expect = fam === 0 ? dDeg + 90 : dDeg; // 水平線的梯度朝上下，垂直線朝左右
      for (let p = 0; p < px.length; p++) {
        if (angDiff(pa[p], expect) > tol) continue;
        const rho = fam === 0 ? -px[p] * sn + py[p] * cs : px[p] * cs + py[p] * sn;
        acc[Math.round(rho) + diag] += pm[p];
      }
      let sc = 0;
      // 相鄰兩格合併，避免線剛好跨在兩個 ρ 之間
      for (let r = 0; r < acc.length - 1; r++) { const v = acc[r] + acc[r + 1]; sc += v * v; }
      score[k] += fam === 0 ? sc : sc * 0.8;
    }
  }
  // 平滑後找峰值
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++)
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j >= 0 && j < n) sm[i] += score[j] * Math.exp(-(k * k) / 4);
    }
  let best = Math.floor(n / 2);
  for (let i = 0; i < n; i++) if (sm[i] > sm[best]) best = i;
  let peak = best;
  if (best > 0 && best < n - 1) {
    const a = sm[best - 1], b = sm[best], c = sm[best + 1];
    const den = a - 2 * b + c;
    if (den !== 0) peak = best + (0.5 * (a - c)) / den;
  }
  const dev = -maxDeg + peak * step;
  // 峰值不夠突出（沒有明確的直線）就不動
  const mean = sm.reduce((s2, v) => s2 + v, 0) / n;
  if (debug) debug.ratio = sm[best] / mean;
  if (sm[best] < mean * 1.15) return 0;
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
