import { defaultFilm, type Film } from './state';

/**
 * 底片特性曲線（H&D 曲線）的參數化版本。
 *
 * 在 log2 曝光域工作：s = log2(x / 0.18) + 曝光偏移。
 * 直線段斜率是 gamma；往暗部用 tanh 漸近到「片基＋霧度」（趾部），往亮部漸近到紙白（肩部）。
 * 這和 shader 裡的 filmCurve() 是同一個公式，UI 用它畫曲線圖、測試用它驗證單調性。
 */
export const MID_GREY = 0.18;
const LOG2_MID = Math.log2(MID_GREY);

export function toeRange(toe: number): number {
  return 8 - (toe / 100) * 5.5; // 8 → 2.5 stops
}
export function shoulderRange(shoulder: number): number {
  return 4.5 - (shoulder / 100) * (4.5 + Math.log2(MID_GREY)); // 4.5 → 2.47 stops（剛好收在 1.0）
}

/** 單一通道：線性曝光 → 線性輸出（0..1） */
export function filmCurve(x: number, f: Pick<Film, 'gamma' | 'toe' | 'shoulder' | 'fade' | 'filmExposure'>, offset = 0, gammaMul = 1): number {
  const s = Math.log2(Math.max(x, 1e-6) / MID_GREY) + f.filmExposure + offset;
  const g = f.gamma * gammaMul;
  const R = s >= 0 ? shoulderRange(f.shoulder) : -toeRange(f.toe);
  const Y = LOG2_MID + R * Math.tanh((g * s) / R);
  const y = Math.min(1, Math.pow(2, Y));
  const fl = (f.fade / 100) * 0.06;
  return fl + (1 - fl) * y;
}

export interface FilmStock {
  id: string;
  name: string;
  latin: string;
  note: string;
  builtin: boolean;
  params: Film;
}

const stock = (id: string, name: string, latin: string, note: string, p: Partial<Film>): FilmStock => ({
  id, name, latin, note, builtin: true,
  params: { ...defaultFilm(), ...p, enabled: true, stock: id },
});

/** 內建配方：全部是虛構的乳劑，數值是照「那種感覺」的物理特性去調，不是抄某個商品 */
export const BUILTIN_STOCKS: FilmStock[] = [
  stock('seiran400', '晴嵐 400', 'Seiran 400', '日系清透：低反差、暗部微青、亮部乾淨', {
    filmExposure: 0.45, gamma: 0.82, toe: 78, shoulder: 70, fade: 32,
    crosstalk: 22, saturation: -14, layerOffset: [-0.06, 0.04, 0.05], layerGamma: [0.96, 1, 1.04],
    iso: 400, grain: 22, grainSize: 42, grainColor: 30, halation: 10, halationRadius: 45, bloom: 6, vignette: -6,
  }),
  stock('amber160', '琥珀 160', 'Amber 160', '暖調人像：膚色紅潤、肩部柔和、細顆粒', {
    filmExposure: 0.2, gamma: 0.9, toe: 60, shoulder: 82, fade: 10,
    crosstalk: 30, saturation: -4, layerOffset: [0.12, 0.02, -0.12], layerGamma: [0.98, 1, 0.97],
    iso: 160, grain: 14, grainSize: 30, grainColor: 25, halation: 14, halationRadius: 40, bloom: 8, vignette: -10,
  }),
  stock('nordic100', '北境 100', 'Nordic 100', '冷調風景：藍天深邃、反差俐落', {
    filmExposure: -0.05, gamma: 1.12, toe: 40, shoulder: 55, fade: 0,
    crosstalk: 10, saturation: 16, layerOffset: [-0.1, 0.0, 0.1], layerGamma: [1.02, 1, 0.97],
    iso: 100, grain: 10, grainSize: 25, grainColor: 25, halation: 4, halationRadius: 35, bloom: 0, vignette: -14,
  }),
  stock('sumi400', '墨 400', 'Sumi 400', '高反差黑白：粗顆粒、黑色結實', {
    mono: true, monoFilter: [0.42, 0.48, 0.1],
    filmExposure: 0.1, gamma: 1.38, toe: 30, shoulder: 45, fade: 4,
    iso: 400, grain: 46, grainSize: 58, grainColor: 0, halation: 0, bloom: 4, vignette: -22,
  }),
  stock('silver100', '銀鹽 100', 'Silver 100', '細緻黑白：灰階豐富、肩部綿長', {
    mono: true, monoFilter: [0.28, 0.6, 0.12],
    filmExposure: 0.15, gamma: 0.92, toe: 66, shoulder: 80, fade: 6,
    iso: 100, grain: 16, grainSize: 26, grainColor: 0, bloom: 6, vignette: -8,
  }),
  stock('neon800', '霓虹 800', 'Neon 800', '夜景電影感：紅色光暈、青綠暗部、暖亮部', {
    filmExposure: 0.3, gamma: 1.0, toe: 55, shoulder: 75, fade: 8,
    crosstalk: 18, saturation: 6, layerOffset: [0.04, 0.0, 0.02], layerGamma: [1.08, 1, 0.9],
    iso: 800, grain: 34, grainSize: 50, grainColor: 45, halation: 62, halationRadius: 55, bloom: 18, vignette: -16,
  }),
  stock('slide50', '正片 50', 'Slide 50', '反轉片：高飽和、黑位深、寬容度窄', {
    filmExposure: -0.2, gamma: 1.32, toe: 25, shoulder: 35, fade: 0,
    crosstalk: 4, saturation: 28, layerOffset: [0.0, 0.02, 0.04], layerGamma: [1.0, 1.02, 1.04],
    iso: 50, grain: 6, grainSize: 18, grainColor: 20, halation: 3, bloom: 0, vignette: -18,
  }),
  stock('faded200', '褪色 200', 'Faded 200', '過期底片：洋紅偏移、黑色泛白、偶有漏光', {
    filmExposure: 0.35, gamma: 0.78, toe: 85, shoulder: 72, fade: 58,
    crosstalk: 40, saturation: -22, layerOffset: [0.14, -0.08, -0.02], layerGamma: [0.92, 1, 1.06],
    iso: 200, grain: 30, grainSize: 48, grainColor: 55, halation: 18, halationRadius: 60, bloom: 10,
    vignette: -20, leak: 38, leakSeed: 0.62,
  }),
  stock('summer200', '盛夏 200', 'Summer 200', '消費級暖色：飽滿、明亮、帶點黃', {
    filmExposure: 0.25, gamma: 1.05, toe: 50, shoulder: 62, fade: 6,
    crosstalk: 14, saturation: 18, layerOffset: [0.08, 0.06, -0.14], layerGamma: [1.0, 1.0, 0.95],
    iso: 200, grain: 20, grainSize: 40, grainColor: 35, halation: 12, halationRadius: 45, bloom: 6, vignette: -12,
  }),
  stock('mist1600', '霧 1600', 'Mist 1600', '高感光弱光：顆粒明顯、色彩低迴', {
    filmExposure: 0.5, gamma: 0.86, toe: 72, shoulder: 76, fade: 18,
    crosstalk: 34, saturation: -26, layerOffset: [-0.02, 0.05, 0.02], layerGamma: [0.97, 1, 1.02],
    iso: 1600, grain: 58, grainSize: 70, grainColor: 50, halation: 24, halationRadius: 60, bloom: 12, vignette: -18,
  }),
];

const USER_KEY = 'pe.filmStocks.v1';

export function loadUserStocks(): FilmStock[] {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as FilmStock[]).map((s) => ({ ...s, builtin: false, params: { ...defaultFilm(), ...s.params } }));
  } catch {
    return [];
  }
}

export function saveUserStocks(list: FilmStock[]): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(list.filter((s) => !s.builtin)));
  } catch {
    /* 私密模式等情況：不保存，但不影響使用 */
  }
}
