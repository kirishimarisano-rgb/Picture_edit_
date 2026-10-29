// 給 Playwright 用的測試頁：把核心管線掛到 window 上
import { Renderer } from '../src/core/gl/renderer';
import { BUILTIN_STOCKS } from '../src/core/film';
import { defaultState, type EditState } from '../src/core/state';

function testImage(w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const band = Math.floor((y / h) * 4);
      const t = x / (w - 1);
      const v = Math.round(t * 255);
      const hue = [ [v, v, v], [v, 255 - v, (v * 3) % 256], [(x * 7) % 256, (y * 5) % 256, ((x ^ y) * 3) % 256], [255 - v, v / 2, v] ][band];
      img.data.set([hue[0], hue[1], hue[2], 255], i);
    }
  return img;
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const r = new Renderer(canvas);
const W = 256, H = 128;
const src = testImage(W, H);
r.loadSource(src, W, H);

function run(s: EditState) {
  r.setState(s);
  return r.renderExport(1, s);
}
function diff(a: Uint8Array) {
  let max = 0, sum = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - src.data[i + c]); max = Math.max(max, d); sum += d; }
  return { max, mean: sum / (a.length * 0.75) };
}

(window as any).glTests = () => {
  const results: Record<string, { max: number; mean: number }> = {};
  results['預設狀態'] = diff(run(defaultState()).data);
  const f = defaultState(); f.film = { ...BUILTIN_STOCKS[0].params, strength: 0 };
  results['底片強度 0'] = diff(run(f).data);
  const sanity = defaultState(); sanity.basic.exposure = 1;
  results['曝光 +1（應該不同）'] = diff(run(sanity).data);
  const stocks: Record<string, number> = {};
  for (const st of BUILTIN_STOCKS) {
    const s = defaultState(); s.film = { ...st.params };
    const d = run(s).data; let bad = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; }
    stocks[st.id] = Math.round(sum / (d.length * 0.75));
  }
  return { results, stocks };
};
(window as any).ready = true;

// 灰階梯：檢查每種配方在不同亮度的色偏
(window as any).rampTest = () => {
  const W2 = 256, H2 = 8;
  const img = new ImageData(W2, H2);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) img.data.set([x, x, x, 255], (y * W2 + x) * 4);
  r.loadSource(img, W2, H2);
  const out: Record<string, string> = {};
  for (const st of BUILTIN_STOCKS) {
    const s = defaultState(); s.film = { ...st.params, grain: 0, vignette: 0, leak: 0, halation: 0, bloom: 0 };
    r.setState(s);
    const d = r.renderExport(1, s).data;
    out[st.id] = [16, 64, 128, 192, 240].map((x) => { const i = (4 * W2 + x) * 4; return `${d[i]},${d[i + 1]},${d[i + 2]}`; }).join(' | ');
  }
  r.loadSource(src, W, H);
  return out;
};
