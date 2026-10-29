import { describe, expect, it } from 'vitest';
import { buildCurveLut, evalCurve } from '../src/core/curves';
import { filmCurve, BUILTIN_STOCKS, MID_GREY } from '../src/core/film';
import { apply, cropFits, cropForAspect, fitCrop, invert, mul, outputSize, outputToSource } from '../src/core/geometry';
import { History } from '../src/core/history';
import { applyLook, defaultState, deserialize, extractLook, sectionModified, serialize } from '../src/core/state';
import { detectTilt, findHealSource, type Gray } from '../src/core/analysis';
import { parseExif } from '../src/core/exif';

describe('曲線', () => {
  it('預設曲線是恆等', () => {
    const lut = buildCurveLut(defaultState().curves);
    for (let i = 0; i < 256; i++) for (let c = 0; c < 4; c++) expect(lut[i * 4 + c]).toBeCloseTo(i / 255, 6);
  });
  it('單調、不過衝', () => {
    const lut = evalCurve([[0, 0], [0.25, 0.15], [0.5, 0.55], [0.75, 0.9], [1, 1]]);
    for (let i = 1; i < lut.length; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-6);
    expect(Math.max(...lut)).toBeLessThanOrEqual(1);
  });
  it('通過控制點', () => {
    const lut = evalCurve([[0, 0], [0.5, 0.7], [1, 1]], 1025);
    expect(lut[512]).toBeCloseTo(0.7, 3);
  });
});

describe('底片特性曲線', () => {
  it('中灰附近斜率約等於 gamma、整體單調、收在 0..1', () => {
    for (const s of BUILTIN_STOCKS) {
      const f = s.params;
      let prev = -1;
      for (let ev = -10; ev <= 8; ev += 0.25) {
        const y = filmCurve(MID_GREY * 2 ** ev, f);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
        prev = y;
      }
    }
    const f = { gamma: 1.2, toe: 50, shoulder: 50, fade: 0, filmExposure: 0 };
    const d = 0.01;
    const slope = (Math.log2(filmCurve(MID_GREY * 2 ** d, f)) - Math.log2(filmCurve(MID_GREY * 2 ** -d, f))) / (2 * d);
    expect(slope).toBeCloseTo(1.2, 2);
  });
  it('肩部 100 時收在紙白', () => {
    const f = { gamma: 1, toe: 50, shoulder: 100, fade: 0, filmExposure: 0 };
    expect(filmCurve(1000, f)).toBeCloseTo(1, 3);
  });
  it('至少 8 種配方且名稱不重複', () => {
    expect(BUILTIN_STOCKS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(BUILTIN_STOCKS.map((s) => s.name)).size).toBe(BUILTIN_STOCKS.length);
  });
});

describe('幾何', () => {
  const W = 6000, H = 4000;
  it('預設幾何是恆等', () => {
    const g = defaultState().geometry;
    const m = outputToSource(W, H, g);
    expect(apply(m, 0.3, 0.7)).toEqual([0.3, 0.7]);
    expect(outputSize(W, H, g)).toEqual([W, H]);
  });
  it('順時針轉 90° 後，輸出左上角來自來源左下角', () => {
    const g = { ...defaultState().geometry, rot90: 1 };
    expect(outputSize(W, H, g)).toEqual([H, W]);
    const [u, v] = apply(outputToSource(W, H, g), 0, 0);
    expect(u).toBeCloseTo(0, 6);
    expect(v).toBeCloseTo(1, 6);
  });
  it('四次 90° 回到原位、反矩陣正確', () => {
    for (let k = 0; k < 4; k++) {
      const g = { ...defaultState().geometry, rot90: k, flipH: k % 2 === 1, angle: 3 };
      const m = outputToSource(W, H, g);
      const p = apply(mul(invert(m), m), 0.2, 0.9);
      expect(p[0]).toBeCloseTo(0.2, 9);
      expect(p[1]).toBeCloseTo(0.9, 9);
    }
  });
  it('拉直後自動縮小裁切框到影像內', () => {
    const g = { ...defaultState().geometry, angle: 8 };
    expect(cropFits(W, H, g)).toBe(false);
    const c = fitCrop(W, H, g);
    expect(cropFits(W, H, { ...g, crop: c })).toBe(true);
    expect(c.w).toBeGreaterThan(0.7);
  });
  it('比例預設產生正確像素比', () => {
    const g = defaultState().geometry;
    const c = cropForAspect('1:1', W, H, g);
    const [w, h] = outputSize(W, H, { ...g, crop: c });
    expect(w / h).toBeCloseTo(1, 2);
  });
});

describe('狀態與歷史', () => {
  it('序列化來回一致、舊檔補預設值', () => {
    const s = defaultState();
    s.basic.exposure = 0.7;
    expect(deserialize(serialize(s))).toEqual(s);
    const partial = deserialize(JSON.stringify({ basic: { exposure: 1 } }));
    expect(partial.basic.contrast).toBe(0);
    expect(partial.film.toe).toBe(50);
  });
  it('預設狀態沒有任何區段被修改', () => {
    const s = defaultState();
    for (const k of ['basic', 'curves', 'hsl', 'split', 'film', 'masks', 'spots'] as const) expect(sectionModified(s, k)).toBe(false);
  });
  it('預設集只帶外觀，不帶裁切與遮罩', () => {
    const a = defaultState();
    a.basic.contrast = 30;
    a.geometry.angle = 5;
    const b = applyLook(defaultState(), extractLook(a));
    expect(b.basic.contrast).toBe(30);
    expect(b.geometry.angle).toBe(0);
  });
  it('歷史：復原、重做、跳躍、分支丟棄、合併', () => {
    const s = defaultState();
    const h = new History(s);
    const a = { ...s, basic: { ...s.basic, exposure: 1 } };
    h.push('曝光', a);
    h.replaceTop('曝光', { ...s, basic: { ...s.basic, exposure: 1.5 } });
    expect(h.entries.length).toBe(2);
    expect(h.undo()!.basic.exposure).toBe(0);
    expect(h.redo()!.basic.exposure).toBe(1.5);
    h.jump(0);
    h.push('對比', { ...s, basic: { ...s.basic, contrast: 10 } });
    expect(h.entries.map((e) => e.label)).toEqual(['開啟', '對比']);
  });
});

function lines(w: number, h: number, deg: number): Gray {
  const data = new Float32Array(w * h);
  const t = Math.tan((deg * Math.PI) / 180);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const yy = y - (x - w / 2) * t;
    data[y * w + x] = 0.5 + 0.3 * Math.sin((2 * Math.PI * yy) / 46);
  }
  return { data, w, h };
}

describe('分析', () => {
  it('偵測傾斜的水平線並回傳反方向角度', () => {
    for (const d of [-6, -2.5, 0, 3, 7.5]) expect(detectTilt(lines(320, 220, d))).toBeCloseTo(-d, 0);
  });
  it('修復來源不會選在原地', () => {
    const g = lines(300, 200, 0);
    const [sx, sy] = findHealSource(g, 150, 100, 8);
    expect(Math.hypot(sx - 150, sy - 100)).toBeGreaterThan(15);
  });
});

describe('EXIF', () => {
  it('讀出 JPEG APP1 裡的欄位', () => {
    // 手工組一個最小的 JPEG + TIFF（大端）
    const tiff: number[] = [];
    const push16 = (v: number) => tiff.push((v >> 8) & 255, v & 255);
    const push32 = (v: number) => { push16(v >>> 16); push16(v & 0xffff); };
    tiff.push(0x4d, 0x4d); push16(42); push32(8);
    push16(2);
    push16(0x8827); push16(3); push32(1); push16(400); push16(0); // ISO
    push16(0x829d); push16(5); push32(1); push32(38); // FNumber -> offset 38
    push32(0);
    push32(28); push32(10); // 2.8
    const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = app1.length + 2;
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xda, 0, 2]);
    const e = parseExif(jpg.buffer);
    expect(e.iso).toBe(400);
    expect(e.fNumber).toBeCloseTo(2.8);
  });
});
