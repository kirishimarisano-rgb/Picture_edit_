import type { BrushDab } from './state';

/** 筆刷遮罩點陣化的解析度（長邊） */
export const BRUSH_LONG = 1024;

export function brushSize(srcW: number, srcH: number): [number, number] {
  const k = BRUSH_LONG / Math.max(srcW, srcH);
  return [Math.max(1, Math.round(srcW * k)), Math.max(1, Math.round(srcH * k))];
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawDab(ctx: Ctx, d: BrushDab, w: number, h: number) {
  const long = Math.max(w, h);
  const x = d.x * w, y = d.y * h, r = Math.max(0.5, d.r * long);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  const a = Math.max(0, Math.min(1, d.flow));
  const hard = Math.max(0, Math.min(0.99, d.hardness));
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(hard, `rgba(255,255,255,${a})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = d.erase ? 'destination-out' : 'source-over';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/** 在兩點之間補上等距的筆觸點，讓快速拖動也是連續的線 */
export function interpolateDabs(from: BrushDab, to: BrushDab, aspect: number): BrushDab[] {
  // aspect = 寬/高；以長邊為 1 的距離
  const sx = aspect >= 1 ? 1 : aspect, sy = aspect >= 1 ? 1 / aspect : 1;
  const dx = (to.x - from.x) * sx, dy = (to.y - from.y) * sy;
  const dist = Math.hypot(dx, dy);
  const spacing = Math.max(1e-4, to.r * 0.22);
  const n = Math.floor(dist / spacing);
  const out: BrushDab[] = [];
  for (let i = 1; i <= n; i++) {
    const t = (i * spacing) / dist;
    out.push({ ...to, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return out;
}
