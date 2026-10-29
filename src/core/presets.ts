import { defaultBasic, defaultFilm, defaultHsl, type LookSettings } from './state';
import { BUILTIN_STOCKS } from './film';

export interface Preset {
  id: string;
  name: string;
  builtin: boolean;
  look: Partial<LookSettings>;
}

const stock = (id: string) => ({ ...BUILTIN_STOCKS.find((s) => s.id === id)!.params });

/** 內建預設集：示範「基本調整＋底片」組合 */
export const BUILTIN_PRESETS: Preset[] = [
  { id: 'p-clear', name: '清透日常', builtin: true, look: { basic: { ...defaultBasic(), exposure: 0.25, contrast: -12, highlights: -35, shadows: 30, whites: 8, vibrance: 18, temp: -4 }, film: stock('seiran400') } },
  { id: 'p-warm', name: '午後暖光', builtin: true, look: { basic: { ...defaultBasic(), exposure: 0.1, highlights: -25, shadows: 15, temp: 14, vibrance: 10, clarity: -8 }, film: stock('amber160') } },
  { id: 'p-cold', name: '冷冽山景', builtin: true, look: { basic: { ...defaultBasic(), contrast: 14, highlights: -40, shadows: 20, clarity: 18, dehaze: 12, temp: -10 }, film: stock('nordic100') } },
  { id: 'p-mono', name: '街頭黑白', builtin: true, look: { basic: { ...defaultBasic(), contrast: 18, highlights: -20, shadows: 10, clarity: 22 }, film: stock('sumi400') } },
  { id: 'p-night', name: '霓虹夜色', builtin: true, look: { basic: { ...defaultBasic(), exposure: 0.15, shadows: 20, temp: -8, vibrance: 12 }, film: stock('neon800') } },
  { id: 'p-fade', name: '舊相簿', builtin: true, look: { basic: { ...defaultBasic(), contrast: -10, blacks: 20, saturation: -10 }, film: stock('faded200'), hsl: { ...defaultHsl(), green: [-20, -30, 0], blue: [-10, -25, 0] } } },
  { id: 'p-flat', name: '只做基本校正', builtin: true, look: { basic: { ...defaultBasic(), highlights: -30, shadows: 25, whites: 10, blacks: -8, vibrance: 12 }, film: defaultFilm() } },
];

const KEY = 'pe.presets.v1';

export function loadUserPresets(): Preset[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Preset[]).map((p) => ({ ...p, builtin: false }));
  } catch {
    return [];
  }
}

export function saveUserPresets(list: Preset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.filter((p) => !p.builtin)));
  } catch {
    /* 無法保存時忽略 */
  }
}
