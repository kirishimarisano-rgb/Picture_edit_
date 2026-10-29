// 所有 GLSL。座標慣例：uv 原點在影像左上角；FBO 第 0 列 = 影像最上面一列。
// 色彩：來源紋理是 SRGB8_ALPHA8，取樣時 GPU 自動解成線性；中間緩衝是 RGBA16F 線性值；最後才編回 sRGB。

export const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float srgbEnc(float x) { x = max(x, 0.0); return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float srgbDec(float x) { x = max(x, 0.0); return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
vec3 enc3(vec3 c) { return vec3(srgbEnc(c.r), srgbEnc(c.g), srgbEnc(c.b)); }
vec3 dec3(vec3 c) { return vec3(srgbDec(c.r), srgbDec(c.g), srgbDec(c.b)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`;

/** 來源 → 低解析度統計圖：R = log2 亮度、G = 亮度、B = 暗通道 */
export const STATS_FS = COMMON + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uSize;
uniform float uLod;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 c = textureLod(uSrc, uv, uLod).rgb;
  float Y = dot(c, LUMA);
  o = vec4(log2(Y + 1e-4), Y, min(min(c.r, c.g), c.b), 1.0);
}`;

/** 可分離高斯模糊 */
export const BLUR_FS = COMMON + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uSize;
uniform vec2 uDir;
uniform float uSigma;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 px = uDir / uSize;
  float reach = uSigma * 3.0;
  float stp = max(1.0, reach / 32.0);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -32; i <= 32; i++) {
    float x = float(i) * stp;
    if (abs(x) > reach + 0.5) continue;
    float w = exp(-x * x / (2.0 * uSigma * uSigma + 1e-6));
    acc += texture(uTex, uv + px * x) * w;
    ws += w;
  }
  o = acc / ws;
}`;

/** 高光暈染的光源：縮小 4 倍並取出亮部 */
export const BRIGHT_FS = COMMON + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uSize;
uniform vec2 uSrcPx;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 c = vec3(0.0);
  c += texture(uTex, uv + vec2(-1.0, -1.0) * uSrcPx).rgb;
  c += texture(uTex, uv + vec2( 1.0, -1.0) * uSrcPx).rgb;
  c += texture(uTex, uv + vec2(-1.0,  1.0) * uSrcPx).rgb;
  c += texture(uTex, uv + vec2( 1.0,  1.0) * uSrcPx).rgb;
  c = max(c * 0.25, 0.0);
  float Y = dot(c, LUMA);
  o = vec4(c * smoothstep(0.45, 1.6, Y), 1.0);
}`;

/**
 * 顯影：幾何 → 修補 → 白平衡 → 曝光 → 去霧 → 亮部/陰影 → 白/黑 → 對比 → 清晰度 → HSL → 鮮豔度/飽和 → 分離色調 → 曲線
 * 每個參數都是「全域值 + Σ 遮罩 × 局部值」，所以局部調整就是同一條管線、逐像素不同的參數。
 */
export const DEVELOP_FS = COMMON + /* glsl */ `
#define MAX_MASKS 8
uniform sampler2D uSrc;
uniform sampler2D uStatS;
uniform sampler2D uStatL;
uniform sampler2D uLut;
uniform sampler2D uSpots;
uniform sampler2DArray uBrush;
uniform vec2 uSize;
uniform mat3 uGeo;
uniform vec2 uSrcSize;
uniform float uLong;

uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uVibrance, uSaturation, uClarity, uDehaze;
uniform bool uCurvesOn;
uniform bool uHslOn;
uniform vec3 uHsl[8];
uniform bool uSplitOn;
uniform vec4 uSplit; // shadowHue, shadowSat, highlightHue, highlightSat（0..1）
uniform float uSplitBalance;

uniform int uSpotCount;
uniform int uMaskCount;
uniform int uMaskType[MAX_MASKS];
uniform vec4 uMaskA[MAX_MASKS];
uniform vec4 uMaskB[MAX_MASKS];
uniform vec4 uMaskAdj0[MAX_MASKS]; // exposure contrast highlights shadows
uniform vec4 uMaskAdj1[MAX_MASKS]; // temp tint saturation clarity
uniform vec4 uMaskAdj2[MAX_MASKS]; // dehaze, invert, layer, 0
uniform int uShowMask;

out vec4 o;

const float HUES[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0, 360.0);

float maskValue(int i, vec2 suv) {
  vec2 p = suv * uSrcSize / uLong;
  float v = 0.0;
  if (uMaskType[i] == 0) {
    vec2 a = uMaskA[i].xy * uSrcSize / uLong;
    vec2 b = uMaskA[i].zw * uSrcSize / uLong;
    vec2 ab = b - a;
    float t = dot(p - a, ab) / max(dot(ab, ab), 1e-8);
    v = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (uMaskType[i] == 1) {
    vec2 c = uMaskA[i].xy * uSrcSize / uLong;
    vec2 r = max(uMaskA[i].zw, vec2(1e-4));
    float an = uMaskB[i].x;
    vec2 d = p - c;
    d = vec2(cos(an) * d.x + sin(an) * d.y, -sin(an) * d.x + cos(an) * d.y);
    float dist = length(d / r);
    float f = clamp(uMaskB[i].y, 0.001, 1.0);
    v = 1.0 - smoothstep(1.0 - f, 1.0, dist);
  } else {
    v = texture(uBrush, vec3(suv, uMaskAdj2[i].z)).r;
  }
  return uMaskAdj2[i].y > 0.5 ? 1.0 - v : v;
}

vec3 sampleSrc(vec2 uv) { return texture(uSrc, uv).rgb; }

vec3 ringMean(vec2 c, float rUv, vec2 aspect, float lod) {
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.785398;
    acc += textureLod(uSrc, c + vec2(cos(a), sin(a)) * rUv * aspect, lod).rgb;
  }
  return acc * 0.125 + 1e-4;
}

vec3 retouch(vec2 suv, vec3 col) {
  vec2 aspect = vec2(uLong / uSrcSize.x, uLong / uSrcSize.y);
  for (int i = 0; i < 256; i++) {
    if (i >= uSpotCount) break;
    vec4 d = texelFetch(uSpots, ivec2(0, i), 0);
    vec4 s = texelFetch(uSpots, ivec2(1, i), 0);
    vec2 dp = (suv - d.xy) * uSrcSize / uLong;
    float dist = length(dp);
    if (dist > d.z) continue;
    float w = 1.0 - smoothstep(d.z * (1.0 - d.w), d.z, dist);
    vec2 off = s.xy - d.xy;
    vec3 c2 = sampleSrc(suv + off);
    if (s.z > 0.5) {
      // 修復：用兩邊「外圈」的低頻比值校正顏色與亮度，只搬紋理
      float lod = max(0.0, log2(d.z * uLong * 0.35));
      vec3 rd = ringMean(d.xy, d.z * 1.15, aspect, lod);
      vec3 rs = ringMean(s.xy, d.z * 1.15, aspect, lod);
      c2 *= rd / rs;
    }
    col = mix(col, c2, w * s.w);
  }
  return col;
}

vec3 wbMul(float temp, float tint) {
  // 簡化的色溫/色調：在線性空間對 R、B（色溫）與 G（色調）做相對增益，再把亮度拉回
  float t = temp / 100.0 * 0.55;
  float g = tint / 100.0 * 0.35;
  vec3 m = vec3(exp2(t), exp2(-g), exp2(-t));
  return m / dot(m, LUMA);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 suv = (uGeo * vec3(uv, 1.0)).xy;
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) {
    o = vec4(0.012, 0.012, 0.012, 0.0);
    return;
  }

  // 逐像素參數 = 全域 + Σ 遮罩
  float exposure = uExposure, contrast = uContrast, highlights = uHighlights, shadows = uShadows;
  float temp = uTemp, tint = uTint, saturation = uSaturation, clarity = uClarity, dehaze = uDehaze;
  float shown = 0.0;
  for (int i = 0; i < MAX_MASKS; i++) {
    if (i >= uMaskCount) break;
    float m = maskValue(i, suv);
    if (i == uShowMask) shown = m;
    exposure += m * uMaskAdj0[i].x;
    contrast += m * uMaskAdj0[i].y;
    highlights += m * uMaskAdj0[i].z;
    shadows += m * uMaskAdj0[i].w;
    temp += m * uMaskAdj1[i].x;
    tint += m * uMaskAdj1[i].y;
    saturation += m * uMaskAdj1[i].z;
    clarity += m * uMaskAdj1[i].w;
    dehaze += m * uMaskAdj2[i].x;
  }

  vec3 c = sampleSrc(suv);
  if (uSpotCount > 0) c = retouch(suv, c);
  float Ysrc = dot(c, LUMA);

  // 白平衡、曝光
  vec3 wb = wbMul(temp, tint);
  c *= wb;
  float gain = exp2(exposure);
  c *= gain;

  // 去霧（暗通道先驗的簡化版）
  if (dehaze != 0.0) {
    vec4 L = texture(uStatL, suv);
    float A = 0.95;
    if (dehaze > 0.0) {
      float dark = L.b * gain * dot(wb, vec3(1.0 / 3.0));
      float t = 1.0 - (dehaze / 100.0) * 0.92 * clamp(dark / A, 0.0, 1.0);
      c = max((c - A) / max(t, 0.18) + A, 0.0);
    } else {
      c = mix(c, vec3(A * 0.82), (-dehaze / 100.0) * 0.55);
    }
  }

  // 亮部 / 陰影：用「像素亮度 + 區域亮度」做遮罩，減少光暈
  if (highlights != 0.0 || shadows != 0.0) {
    float Y = dot(c, LUMA);
    float Yl = texture(uStatL, suv).g * gain;
    float pl = srgbEnc(mix(Y, Yl, 0.55));
    float ev = (shadows / 100.0) * 1.3 * pow(1.0 - smoothstep(0.0, 0.6, pl), 1.5)
             + (highlights / 100.0) * 1.4 * smoothstep(0.35, 1.05, pl);
    c *= exp2(ev);
  }

  // 白色 / 黑色 / 對比：在感知亮度上做，再用比例套回 RGB（色相不變）
  if (uWhites != 0.0 || uBlacks != 0.0 || contrast != 0.0) {
    float Y = dot(c, LUMA);
    float p = srgbEnc(Y);
    p += (uWhites / 100.0) * 0.28 * pow(clamp(p, 0.0, 1.0), 3.0);
    p += (uBlacks / 100.0) * 0.12 * pow(1.0 - clamp(p, 0.0, 1.0), 3.0);
    float k = contrast >= 0.0 ? contrast / 100.0 * 0.5 : contrast / 100.0 * 0.85;
    float pc = clamp(p, 0.0, 1.0);
    p = pc + k * (pc - 0.5) * 4.0 * pc * (1.0 - pc) + (p - pc);
    float Yn = srgbDec(max(p, 0.0));
    c *= Y > 1e-6 ? Yn / Y : 1.0;
    if (Y <= 1e-6) c += vec3(Yn);
  }

  // 清晰度：中間調的區域反差（log 域，和曝光無關）
  if (clarity != 0.0) {
    float detail = clamp(log2(Ysrc + 1e-4) - texture(uStatS, suv).r, -2.5, 2.5);
    float p = srgbEnc(dot(c, LUMA));
    float mid = clamp(4.0 * p * (1.0 - p), 0.0, 1.0);
    c *= exp2((clarity / 100.0) * 0.75 * detail * mid);
  }

  // HSL 混色器
  if (uHslOn) {
    float mx = max(1.0, max(c.r, max(c.g, c.b)));
    vec3 e = enc3(c / mx);
    vec3 hsv = rgb2hsv(e);
    float h = hsv.x * 360.0;
    vec3 adj = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = HUES[i], b = HUES[i + 1];
      if (h >= a && h < b) {
        float t = smoothstep(0.0, 1.0, (h - a) / (b - a));
        adj = uHsl[i] * (1.0 - t) + uHsl[(i + 1) % 8] * t;
      }
    }
    float satW = smoothstep(0.0, 0.25, hsv.y);
    hsv.x = fract(hsv.x + adj.x * 30.0 / 360.0 * satW + 1.0);
    hsv.y = clamp(hsv.y * (1.0 + adj.y * satW), 0.0, 1.0);
    vec3 n = dec3(hsv2rgb(hsv)) * mx;
    c = n * exp2(adj.z * 1.2 * hsv.y * satW);
  }

  // 鮮豔度 / 飽和度
  if (uVibrance != 0.0 || saturation != 0.0) {
    float Y = dot(c, LUMA);
    vec3 e = enc3(c);
    float mx = max(e.r, max(e.g, e.b)), mn = min(e.r, min(e.g, e.b));
    float s = (mx - mn) / max(mx, 1e-5);
    float hue = rgb2hsv(clamp(e, 0.0, 1.0)).x * 360.0;
    float skin = 1.0 - 0.6 * smoothstep(8.0, 22.0, hue) * (1.0 - smoothstep(42.0, 60.0, hue));
    float amt = saturation / 100.0 + (uVibrance / 100.0) * pow(1.0 - s, 2.0) * skin;
    c = max(vec3(Y) + (c - vec3(Y)) * (1.0 + amt), 0.0);
  }

  // 分離色調：在感知空間加上零均值的色彩偏移
  if (uSplitOn) {
    vec3 e = enc3(c);
    float p = dot(e, LUMA);
    float pivot = 0.5 - uSplitBalance * 0.25;
    float ws = 1.0 - smoothstep(0.0, 2.0 * pivot, p);
    float wh = smoothstep(2.0 * pivot - 1.0, 1.0, p);
    vec3 sc = hsv2rgb(vec3(uSplit.x, 1.0, 1.0)); sc -= dot(sc, vec3(1.0 / 3.0));
    vec3 hc = hsv2rgb(vec3(uSplit.z, 1.0, 1.0)); hc -= dot(hc, vec3(1.0 / 3.0));
    e += sc * uSplit.y * ws * 0.22 + hc * uSplit.w * wh * 0.22;
    c = dec3(max(e, 0.0));
  }

  // 曲線（感知空間）
  if (uCurvesOn) {
    vec3 e = enc3(c);
    vec3 ec = clamp(e, 0.0, 1.0);
    vec3 r;
    r.r = texture(uLut, vec2((ec.r * 255.0 + 0.5) / 256.0, 0.5)).r;
    r.g = texture(uLut, vec2((ec.g * 255.0 + 0.5) / 256.0, 0.5)).g;
    r.b = texture(uLut, vec2((ec.b * 255.0 + 0.5) / 256.0, 0.5)).b;
    c = dec3(r + (e - ec));
  }

  o = vec4(max(c, 0.0), shown);
}`;

/** 底片：暈染 → 暗角/漏光（曝光域）→ 感光層串擾 → 特性曲線 → 顆粒 → 片邊 → 編回 sRGB */
export const FILM_FS = COMMON + /* glsl */ `
uniform sampler2D uDev;
uniform sampler2D uHalo;
uniform vec2 uSize;
uniform vec2 uFull;        // 輸出影像的全解析度尺寸（顆粒以此為座標，預覽與匯出一致）
uniform bool uFilmOn;
uniform float uStrength;
uniform float uFilmExposure, uGamma, uToeR, uShoulderR, uFade;
uniform vec2 uWhite; // 白點補償（stops）、白點的 s
uniform mat3 uCross;
uniform float uFilmSat;
uniform bool uMono;
uniform vec3 uMonoFilter;
uniform vec3 uLayerOffset, uLayerGamma;
uniform float uGrain, uGrainCell, uGrainColor;
uniform float uHalation, uBloom;
uniform float uVignette, uVignetteSize;
uniform float uLeak, uLeakSeed;
uniform bool uBorder;
uniform int uShowMask;
out vec4 o;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float gauss(ivec2 p, int seed) {
  uvec3 h = pcg3d(uvec3(uint(p.x + 65536), uint(p.y + 65536), uint(seed)));
  vec3 u = vec3(h) / 4294967295.0;
  return (u.x + u.y + u.z - 1.5) * 2.0;
}
float vnoise(vec2 p, int seed) {
  vec2 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 q = ivec2(i);
  float a = gauss(q, seed), b = gauss(q + ivec2(1, 0), seed);
  float c = gauss(q + ivec2(0, 1), seed), d = gauss(q + ivec2(1, 1), seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 1.45;
}
float grainField(vec2 p, int seed) {
  // 三個尺度的顆粒；在預覽縮小時依取樣距離衰減，避免小圖的顆粒比原尺寸還吵
  float s = uSize.x / uFull.x;
  float c0 = uGrainCell, c1 = uGrainCell * 2.3, c2 = uGrainCell * 0.55;
  return 0.62 * vnoise(p / c0, seed) * clamp(c0 * s, 0.0, 1.0)
       + 0.40 * vnoise(p / c1, seed + 17) * clamp(c1 * s, 0.0, 1.0)
       + 0.30 * vnoise(p / c2, seed + 41) * clamp(c2 * s, 0.0, 1.0);
}

float curve(float s, float g) {
  float R = s >= 0.0 ? uShoulderR : -uToeR;
  float w = clamp(s / uWhite.y, 0.0, 1.0);
  float Y = log2(0.18) + R * tanh(g * s / R) + uWhite.x * w * w;
  return min(1.0, exp2(Y));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 iuv = uv;
  float aspect = uFull.x / uFull.y;
  bool rebate = false;
  if (uFilmOn && uBorder) {
    float m = 0.045;
    vec2 inset = vec2(m / aspect, m);
    if (aspect < 1.0) inset = vec2(m, m * aspect);
    iuv = (uv - inset) / (1.0 - 2.0 * inset);
    // 片框內緣略帶不規則：用低頻雜訊推動邊界
    float jag = vnoise(uv * uFull / 9.0, 99) * 0.00035 + vnoise(uv * uFull / 60.0, 98) * 0.0012;
    vec2 q = abs(iuv - 0.5) * 2.0;
    vec2 cr = vec2(0.012 / aspect, 0.012);
    vec2 d = max(q - (1.0 - cr), 0.0) / cr;
    rebate = q.x > 1.0 + jag || q.y > 1.0 + jag || length(d) > 1.0 + jag * 20.0;
  }
  vec4 dev = texture(uDev, iuv);
  vec3 x = max(dev.rgb, 0.0);
  vec3 outc = x;

  if (uFilmOn) {
    vec3 e = x;
    vec3 halo = texture(uHalo, iuv).rgb;
    e += halo * uHalation * vec3(1.0, 0.24, 0.05) * 2.2;
    e += halo * uBloom * 0.8;

    // 暗角（曝光域，交給底片肩部自然收）
    vec2 vq = (iuv - 0.5) * 2.0 * vec2(aspect, 1.0) / length(vec2(aspect, 1.0));
    float vd = length(vq) * 1.414;
    float inner = mix(0.95, 0.05, uVignetteSize);
    float vf = smoothstep(inner, 1.45, vd);
    e *= exp2(uVignette * 1.8 * vf * vf);

    // 漏光：從片匣邊緣滲入的暖色光
    if (uLeak > 0.0) {
      float side = uLeakSeed < 0.5 ? -0.08 : 1.08;
      vec2 c1 = vec2(side, fract(uLeakSeed * 7.31) * 0.8 + 0.1);
      vec2 c2 = vec2(side, fract(uLeakSeed * 13.7) * 0.8 + 0.1);
      vec2 d1 = (iuv - c1) * vec2(aspect * 2.4, 1.0);
      vec2 d2 = (iuv - c2) * vec2(aspect * 4.0, 1.6);
      float l1 = exp(-dot(d1, d1) * 3.2);
      float l2 = exp(-dot(d2, d2) * 6.0);
      vec3 core = vec3(1.0, 0.72, 0.32), rim = vec3(1.0, 0.18, 0.04);
      e += uLeak * (mix(rim, core, l1) * l1 * 2.4 + rim * l2 * 1.6);
    }

    if (uMono) e = vec3(dot(e, uMonoFilter));
    vec3 s = log2(max(e, 1e-6) / 0.18) + uFilmExposure + uLayerOffset;
    s = uCross * s;
    float sl = dot(s, LUMA);
    s = sl + (s - sl) * (1.0 + uFilmSat);
    vec3 g = uGamma * uLayerGamma;
    vec3 y = vec3(curve(s.r, g.r), curve(s.g, g.g), curve(s.b, g.b));

    // 顆粒：乘在 log 輸出上，暗部與中間調較明顯
    if (uGrain > 0.0) {
      vec2 gp = iuv * uFull;
      float pY = srgbEnc(dot(y, LUMA));
      float w = (0.3 + 0.7 * pow(1.0 - pY, 1.5)) * smoothstep(-0.02, 0.1, pY);
      float nm = grainField(gp, 1);
      vec3 n = vec3(nm);
      if (uGrainColor > 0.0 && !uMono) n = mix(n, vec3(grainField(gp, 2), grainField(gp, 3), grainField(gp, 4)), uGrainColor);
      y *= exp2(n * uGrain * w);
    }
    y = uFade + (1.0 - uFade) * y;
    outc = mix(x, y, uStrength);
    if (rebate) {
      float n = vnoise(uv * uFull / 2.0, 7) * 0.0012;
      outc = vec3(0.0045 + n);
    }
  }

  vec3 enc = enc3(outc);
  if (uShowMask >= 0) enc = mix(enc, vec3(0.91, 0.23, 0.17), dev.a * 0.6);
  // 8 位元輸出前加一點點抖動，避免平滑漸層出現色階
  float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  o = vec4(clamp(enc + dither, 0.0, 1.0), 1.0);
}`;

/** 把結果畫到畫面上：縮放平移、前後對比、照片陰影 */
export const DISPLAY_FS = COMMON + /* glsl */ `
uniform sampler2D uOut;
uniform sampler2D uSrc;
uniform vec2 uCanvas;
uniform vec4 uRect;     // 照片在畫布上的位置（px，左上原點）
uniform float uSplitX;  // 這個 x 以左顯示原圖
uniform mat3 uGeo;
uniform vec3 uBg;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 uv = (p - uRect.xy) / uRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    vec2 d = max(max(uRect.xy - p, p - (uRect.xy + uRect.zw)), 0.0);
    float shadow = exp(-length(d) / 22.0) * 0.45 * smoothstep(-8.0, 30.0, length(d));
    o = vec4(uBg * (1.0 - shadow), 1.0);
    return;
  }
  vec3 c;
  if (p.x < uSplitX) {
    vec2 suv = (uGeo * vec3(uv, 1.0)).xy;
    if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) c = vec3(0.05);
    else c = enc3(texture(uSrc, suv).rgb);
  } else {
    c = texture(uOut, uv).rgb;
  }
  o = vec4(c, 1.0);
}`;

/** 縮圖、直方圖用的縮小複製 */
export const BLIT_FS = COMMON + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uSize;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  o = vec4(texture(uTex, uv).rgb, 1.0);
}`;
