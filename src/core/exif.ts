export interface Exif {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  fNumber?: number;
  exposureTime?: number;
  focalLength?: number;
  focal35?: number;
  date?: string;
  orientation?: number;
}

const TAGS: Record<number, keyof Exif | 'exifPtr'> = {
  0x010f: 'make',
  0x0110: 'model',
  0x0112: 'orientation',
  0x0132: 'date',
  0x8769: 'exifPtr',
  0x829a: 'exposureTime',
  0x829d: 'fNumber',
  0x8827: 'iso',
  0x9003: 'date',
  0x920a: 'focalLength',
  0xa405: 'focal35',
  0xa434: 'lens',
};

/** 讀 JPEG（APP1）、PNG（eXIf）、WebP（EXIF chunk）裡的 TIFF 結構 */
export function parseExif(buf: ArrayBuffer): Exif {
  const v = new DataView(buf);
  try {
    const tiff = findTiff(v);
    return tiff === null ? {} : readTiff(v, tiff);
  } catch {
    return {};
  }
}

function findTiff(v: DataView): number | null {
  if (v.byteLength < 12) return null;
  // JPEG
  if (v.getUint16(0) === 0xffd8) {
    let p = 2;
    while (p + 4 < v.byteLength) {
      const marker = v.getUint16(p);
      const len = v.getUint16(p + 2);
      if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966 /* Exif */) return p + 10;
      if (marker === 0xffda) break;
      p += 2 + len;
    }
    return null;
  }
  // PNG
  if (v.getUint32(0) === 0x89504e47) {
    let p = 8;
    while (p + 8 < v.byteLength) {
      const len = v.getUint32(p);
      const type = v.getUint32(p + 4);
      if (type === 0x65584966 /* eXIf */) return p + 8;
      p += 12 + len;
    }
    return null;
  }
  // WebP
  if (v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    let p = 12;
    while (p + 8 < v.byteLength) {
      const type = v.getUint32(p);
      const len = v.getUint32(p + 4, true);
      if (type === 0x45584946 /* EXIF */) {
        const s = p + 8;
        return v.getUint32(s) === 0x45786966 ? s + 6 : s;
      }
      p += 8 + len + (len & 1);
    }
  }
  return null;
}

function readTiff(v: DataView, base: number): Exif {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (o: number) => v.getUint16(base + o, le);
  const u32 = (o: number) => v.getUint32(base + o, le);
  const out: Exif = {};
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  const readIfd = (off: number, depth: number) => {
    if (depth > 2 || base + off + 2 > v.byteLength) return;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (base + e + 12 > v.byteLength) return;
      const tag = TAGS[u16(e)];
      if (!tag) continue;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (sizes[type] ?? 1) * count;
      const vo = size > 4 ? u32(e + 8) : e + 8;
      let val: number | string | undefined;
      if (type === 2) {
        let s = '';
        for (let k = 0; k < count - 1 && base + vo + k < v.byteLength; k++) s += String.fromCharCode(v.getUint8(base + vo + k));
        val = s.trim();
      } else if (type === 3) val = u16(vo);
      else if (type === 4) val = u32(vo);
      else if (type === 5 || type === 10) {
        const d = u32(vo + 4);
        val = d ? u32(vo) / d : undefined;
      }
      if (val === undefined) continue;
      if (tag === 'exifPtr') readIfd(val as number, depth + 1);
      else (out as Record<string, unknown>)[tag] = val;
    }
  };
  readIfd(u32(4), 0);
  return out;
}

export function formatExposure(t?: number): string | undefined {
  if (!t) return undefined;
  return t >= 0.5 ? `${+t.toFixed(1)} s` : `1/${Math.round(1 / t)} s`;
}

/** 右面板那一行：ISO 200 · 35 mm · f/5.6 · 1/250 s */
export function exifLine(e: Exif): string[] {
  const parts: string[] = [];
  if (e.iso) parts.push(`ISO ${e.iso}`);
  if (e.focalLength) parts.push(`${Math.round(e.focalLength)} mm`);
  if (e.fNumber) parts.push(`f/${+e.fNumber.toFixed(1)}`);
  const ex = formatExposure(e.exposureTime);
  if (ex) parts.push(ex);
  return parts;
}
