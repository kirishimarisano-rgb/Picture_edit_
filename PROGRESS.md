# PROGRESS

## M0 · 地基 ✅
- Vite + TypeScript + Vitest；`npm run build:single` 可輸出單一 HTML
- DESIGN.md（對齊專案設計稿，灰階改為完全中性）、PLAN.md
- `EditState`：可序列化、帶版本號、讀舊檔會補預設值

## M1 · 處理核心 ✅
- WebGL2 管線：SRGB8 來源（含 mipmap）→ RGBA16F 線性顯影 → 高光暈染（1/4 解析度）→ 底片 → RGBA8 sRGB
- 512px 統計圖（log 亮度、亮度、暗通道）兩種半徑模糊，供清晰度、去霧、亮部/陰影使用
- `e2e/gl-identity.mjs`：在 Chromium 裡實際執行 shader，預設狀態與底片強度 0 時輸出和輸入最大差 1/255（輸出抖動），10 種配方皆無黑畫面或爆白
