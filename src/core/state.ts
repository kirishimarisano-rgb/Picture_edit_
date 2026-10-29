// 編輯紀錄：一份可序列化的 JSON，描述「怎麼從原圖算出結果」。原圖永遠不被改動。

export const STATE_VERSION = 1;

export interface Basic {
  exposure: number; // EV，-5..5
  contrast: number; // -100..100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temp: number; // -100..100（相對色溫，藍 ↔ 黃）
  tint: number; // -100..100（綠 ↔ 洋紅）
  vibrance: number;
  saturation: number;
  clarity: number;
  dehaze: number;
}

export type CurvePoint = [number, number];
export interface Curves {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslBand = (typeof HSL_BANDS)[number];
/** 每個色相帶：[色相偏移, 飽和, 明度]，皆 -100..100 */
export type Hsl = Record<HslBand, [number, number, number]>;

export interface SplitTone {
  shadowHue: number; // 0..360
  shadowSat: number; // 0..100
  highlightHue: number;
  highlightSat: number;
  balance: number; // -100..100
}

export interface Film {
  enabled: boolean;
  stock: string; // 來源配方 id（只是標記，參數全在下面）
  strength: number; // 0..100，整體混合
  // 特性曲線
  filmExposure: number; // EV
  gamma: number; // 直線段斜率 0.4..2
  toe: number; // 0..100，越大暗部越柔
  shoulder: number; // 0..100，越大亮部越柔
  fade: number; // 0..100，黑色抬升（片基霧度）
  // 感光層
  crosstalk: number; // 0..100，層間串擾
  saturation: number; // -100..100
  mono: boolean;
  monoFilter: [number, number, number]; // 黑白時的光譜權重
  layerOffset: [number, number, number]; // 各層曝光偏移（EV）→ 色偏
  layerGamma: [number, number, number]; // 各層反差差異 → 交叉色偏
  // 結構
  iso: number; // 50..3200
  grain: number; // 0..100
  grainSize: number; // 0..100
  grainColor: number; // 0..100，彩色顆粒比例
  halation: number; // 0..100
  halationRadius: number; // 0..100
  bloom: number; // 0..100
  vignette: number; // -100..100
  vignetteSize: number; // 0..100
  leak: number; // 0..100
  leakSeed: number; // 0..1
  border: boolean;
}

export type LocalKey = 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'temp' | 'tint' | 'saturation' | 'clarity' | 'dehaze';
export const LOCAL_KEYS: LocalKey[] = ['exposure', 'contrast', 'highlights', 'shadows', 'temp', 'tint', 'saturation', 'clarity', 'dehaze'];
export type LocalAdjust = Record<LocalKey, number>;

export interface BrushDab {
  x: number; // 來源影像 uv
  y: number;
  r: number; // 半徑（以影像長邊為 1）
  hardness: number; // 0..1
  flow: number; // 0..1
  erase: boolean;
}

interface MaskBase {
  id: string;
  name: string;
  visible: boolean;
  invert: boolean;
  adjust: LocalAdjust;
}
export interface LinearMask extends MaskBase {
  type: 'linear';
  // 漸層從 a（100%）到 b（0%），來源 uv
  a: [number, number];
  b: [number, number];
}
export interface RadialMask extends MaskBase {
  type: 'radial';
  cx: number;
  cy: number;
  rx: number; // 以長邊為 1
  ry: number;
  angle: number; // 弧度
  feather: number; // 0..1
}
export interface BrushMask extends MaskBase {
  type: 'brush';
  dabs: BrushDab[];
}
export type Mask = LinearMask | RadialMask | BrushMask;

export interface Spot {
  id: string;
  mode: 'heal' | 'clone';
  // 來源影像 uv；半徑以長邊為 1
  x: number;
  y: number;
  sx: number;
  sy: number;
  r: number;
  feather: number; // 0..1
  opacity: number; // 0..1
}

export interface Geometry {
  rot90: number; // 0..3（順時針 90° 的次數）
  flipH: boolean;
  flipV: boolean;
  angle: number; // 拉直角度（度），-45..45
  crop: { x: number; y: number; w: number; h: number }; // 正規化於旋轉後的畫框
  aspect: string; // 'free' | 'original' | '1:1' | ...
}

export interface EditState {
  version: number;
  basic: Basic;
  curves: Curves;
  hsl: Hsl;
  split: SplitTone;
  film: Film;
  masks: Mask[];
  spots: Spot[];
  geometry: Geometry;
  /** 區段暫時關閉（眼睛圖示） */
  disabled: Partial<Record<SectionKey, boolean>>;
}

export type SectionKey = 'basic' | 'curves' | 'hsl' | 'split' | 'film' | 'masks' | 'spots';

export const defaultBasic = (): Basic => ({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0, clarity: 0, dehaze: 0,
});

export const identityCurve = (): CurvePoint[] => [[0, 0], [1, 1]];
export const defaultCurves = (): Curves => ({ rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() });

export const defaultHsl = (): Hsl =>
  Object.fromEntries(HSL_BANDS.map((b) => [b, [0, 0, 0]])) as unknown as Hsl;

export const defaultSplit = (): SplitTone => ({ shadowHue: 210, shadowSat: 0, highlightHue: 40, highlightSat: 0, balance: 0 });

export const defaultFilm = (): Film => ({
  enabled: false, stock: 'none', strength: 100,
  filmExposure: 0, gamma: 1, toe: 50, shoulder: 50, fade: 0,
  crosstalk: 0, saturation: 0, mono: false, monoFilter: [0.3, 0.59, 0.11],
  layerOffset: [0, 0, 0], layerGamma: [1, 1, 1],
  iso: 200, grain: 0, grainSize: 50, grainColor: 30,
  halation: 0, halationRadius: 50, bloom: 0,
  vignette: 0, vignetteSize: 50, leak: 0, leakSeed: 0.37, border: false,
});

export const defaultLocal = (): LocalAdjust => ({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, temp: 0, tint: 0, saturation: 0, clarity: 0, dehaze: 0,
});

export const defaultGeometry = (): Geometry => ({
  rot90: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'original',
});

export const defaultState = (): EditState => ({
  version: STATE_VERSION,
  basic: defaultBasic(),
  curves: defaultCurves(),
  hsl: defaultHsl(),
  split: defaultSplit(),
  film: defaultFilm(),
  masks: [],
  spots: [],
  geometry: defaultGeometry(),
  disabled: {},
});

export const clone = <T>(v: T): T => structuredClone(v);

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export function serialize(s: EditState): string {
  return JSON.stringify(s);
}

/** 讀入 JSON；缺少的欄位用預設值補齊，讓舊版紀錄也能開 */
export function deserialize(json: string): EditState {
  const raw = JSON.parse(json) as Partial<EditState>;
  return mergeDefaults(defaultState(), raw) as EditState;
}

function mergeDefaults(def: unknown, v: unknown): unknown {
  if (v === undefined || v === null) return def;
  if (Array.isArray(def) || Array.isArray(v)) return v;
  if (typeof def === 'object' && def && typeof v === 'object') {
    const out: Record<string, unknown> = { ...(v as object) };
    for (const [k, dv] of Object.entries(def)) out[k] = mergeDefaults(dv, (v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

const isIdentityCurve = (c: CurvePoint[]) => c.every(([x, y]) => Math.abs(x - y) < 1e-6);

export function sectionModified(s: EditState, key: SectionKey): boolean {
  switch (key) {
    case 'basic': return Object.values(s.basic).some((v) => v !== 0);
    case 'curves': return !(isIdentityCurve(s.curves.rgb) && isIdentityCurve(s.curves.r) && isIdentityCurve(s.curves.g) && isIdentityCurve(s.curves.b));
    case 'hsl': return Object.values(s.hsl).some((t) => t.some((v) => v !== 0));
    case 'split': return s.split.shadowSat > 0 || s.split.highlightSat > 0;
    case 'film': return s.film.enabled;
    case 'masks': return s.masks.length > 0;
    case 'spots': return s.spots.length > 0;
  }
}

/** 預設集只帶「外觀」相關的區段，不帶裁切、遮罩、修補這些跟單張照片綁定的東西 */
export type LookSettings = Pick<EditState, 'basic' | 'curves' | 'hsl' | 'split' | 'film'>;
export function extractLook(s: EditState): LookSettings {
  return clone({ basic: s.basic, curves: s.curves, hsl: s.hsl, split: s.split, film: s.film });
}
export function applyLook(s: EditState, look: Partial<LookSettings>): EditState {
  const n = clone(s);
  if (look.basic) n.basic = { ...defaultBasic(), ...clone(look.basic) };
  if (look.curves) n.curves = clone(look.curves);
  if (look.hsl) n.hsl = { ...defaultHsl(), ...clone(look.hsl) };
  if (look.split) n.split = { ...defaultSplit(), ...clone(look.split) };
  if (look.film) n.film = { ...defaultFilm(), ...clone(look.film) };
  return n;
}
