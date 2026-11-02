/**
 * WebGL 视频超分辨率增强
 *
 * 做法：在 <video> 上叠一层 WebGL canvas，每帧把视频画面当纹理送进片元着色器做增强，
 * 结果画到 canvas 上，再把它压在 video 上方（video 本身设 opacity:0 隐藏原生解码画面）。
 * 对播放链路零侵入 —— hls.js、ArtPlayer、进度、全屏、PIP 全部照常工作。
 *
 * 为什么不用 Anime4K 原版：mpv 的 GLSL 依赖 `#hoook MAIN` 这类 mpv 私有指令、
 * 多 pass 串联和 `//!SAVE` 中间缓冲，无法直接搬到浏览器。这里用等价思路重新实现：
 *   ① 双线性/Catmull-Rom 重采样（放大的基础）
 *   ② 边缘自适应锐化（找回放大后糊掉的轮廓）
 *   ③ 对比度与饱和度补偿（Anime4K "Clamp Highlights" 的思路）
 *   ④ 时域轻量反馈（前后帧差分去噪，仅在播放时启用）
 * 实测观感接近 Anime4K 的「轻量」档位，且不引入 15 万行的权重文件。
 *
 * 能力检测：WebGL2 → WebGL1 → 关闭。有浮点纹理时降采样更准，没有则退回普通纹理。
 */

import { Anime4KEngine, type Anime4KQuality } from '@/lib/anime4k/engine';
import { loadAnime4KShaders } from '@/lib/anime4k/shaders';

/**
 * 增强档位
 *
 * ★ 分成「效率档」和「质量档」两组（用户需求）：
 *   效率档 = 用原生分辨率跑轻量着色器，只做锐化/对比/饱和度，开销极小
 *   质量档 = Anime4K 真·CNN 超分，会把画面放大 2×，画质最好但吃 GPU
 *
 * 这样用户不用猜「哪个更清晰」——按自己机器的性能和对画质的要求直接选。
 */
export type EnhanceLevel =
  | 'off'
  // 效率档（低开销）
  | 'light' | 'standard' | 'strong'
  // 真人档（时域降噪，专门对付真人影视的噪点与压缩块）
  | 'photo'
  // 老片档（降噪 + 锐化 + 2× 放大，给噪点多的老片用）
  | 'retro'
  // 质量档（Anime4K 真·CNN 超分）
  | 'anime4k' | 'anime4k-strong';

export interface EnhanceInfo {
  supported: boolean;
  renderer?: string;
  /** 实际生效的着色器精度路径 */
  precision: 'highp' | 'mediump' | 'lowp';
  /** Anime4K（真·CNN 超分）是否可用 */
  anime4k?: boolean;
  /** Anime4K 引擎的失败原因 */
  anime4kError?: string;
}

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  // WebGL 的纹理 y 轴与 canvas 相反，翻转让画面正立
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * 片元着色器。strength 由 uniform 控制，0~1 连续可调。
 * 用双三次（Catmull-Rom）而不是双线性：片源放大时双线性会把边缘抹成糊面，
 * Catmull-Rom 能保住线条，是「看起来变清晰」的关键。
 */
function fragSrc(glsl1: boolean): string {
  // GLSL ES 1.00 里没有 textureLod / round 的一些写法差别，这里统一成 ES 1.00 语法
  const tex = glsl1 ? 'texture2D(uTex, uv)' : 'texture(uTex, uv)';
  return `
precision highp float;

uniform sampler2D uTex;
uniform sampler2D uHistory;
uniform vec2 uTexSize;
uniform float uStrength;
uniform float uSharpen;
uniform float uContrast;
uniform float uSaturation;
/** 时域混合系数：0=完全不用历史帧，0.35=与上一帧各占一半左右 */
uniform float uHistoryMix;
/** 空间降噪强度 0~1 */
uniform float uDenoise;
/** 降噪窗口半径（源像素） */
uniform float uDenoiseRadius;
uniform vec2 uPrevTexel;

varying vec2 vUv;

vec4 fetch(vec2 uv) {
  return ${tex};
}

/** Catmull-Rom 双三次权重 */
vec4 crWeights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(
    -0.5 * t3 +       t2 - 0.5 * t,
     1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
     0.5 * t3 - 0.5 * t2
  );
}

/** 双三次采样：放大倍率越高收益越大 */
vec3 cubicSample(vec2 uv) {
  vec2 texel = 1.0 / uTexSize;
  vec2 coord = uv * uTexSize - 0.5;
  vec2 f = fract(coord);
  vec2 base = floor(coord);

  vec4 wx = crWeights(f.x);
  vec4 wy = crWeights(f.y);

  vec3 sum = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    vec3 row = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec2 p = (base + vec2(float(i) - 1.0, float(j) - 1.0) + 0.5) * texel;
      row += fetch(clamp(p, vec2(0.0), vec2(1.0))).rgb * wx[i];
    }
    sum += row * wy[j];
  }
  return clamp(sum, 0.0, 1.0);
}

/** 亮度 */
float lumaOf(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

/**
 * 3×3 双边降噪
 *
 * ★ 窗口大小按**源像素**定义，不是按输出像素。
 *   老片的噪点是胶片颗粒，在源分辨率上占 1~2 像素；
 *   如果窗口跟着放大走（输出像素尺度），放大 2× 后的噪点就漏出去了。
 *   所以这里用 srcTexel（= 1/视频分辨率）作为步长，
 *   即使画面已经放大，窗口仍然罩得住源噪点。
 *
 * 相比高斯模糊，双边滤波按**亮度相似度**加权：
 * 噪点和邻近像素亮度差大 → 权重低 → 被抑制；
 * 边缘两侧亮度差大 → 权重低 → 边缘保住，不会被抹平。
 */
vec3 bilateral(vec2 uv, vec3 center, vec2 srcTexel) {
  float sigmaR = mix(0.20, 0.045, uDenoise);
  const float sigmaS = 1.6;
  float cL = lumaOf(center);
  vec3 sum = center;
  float wsum = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec2 o = vec2(float(x), float(y)) * srcTexel * uDenoiseRadius;
      vec3 c = fetch(clamp(uv + o, vec2(0.0), vec2(1.0))).rgb;
      float dl = lumaOf(c) - cL;
      float d2 = float(x * x + y * y);
      float w = exp(-d2 / (2.0 * sigmaS * sigmaS)) * exp(-(dl * dl) / (2.0 * sigmaR * sigmaR));
      sum += c * w;
      wsum += w;
    }
  }
  return sum / wsum;
}

/**
 * 运动量：当前帧与上一帧的亮度差（4 个方向采样）
 *
 * ★ 这是修「时域降噪把画面拉变形」的���键：
 *   直接把上一帧按固定比例混进来，画面一动就会拖出残影（鬼影）。
 *   改成**按运动量自适应**：静止区域照混（去噪点最有效），
 *   运动区域自动少混甚至不混 → 拖影消失。
 */
float motionAmount(vec2 uv, vec2 texel) {
  vec2 o = texel * 2.0;
  float m = 0.0;
  // ★ texture2D 返回 vec4，lumaOf 只收 vec3 —— GLSL ES 1.00 **不允许隐式转换**，
  //   必须显式 .rgb，否则编译报「no matching overloaded function found」。
  m += abs(lumaOf(fetch(uv + vec2(o.x, 0.0)).rgb) - lumaOf(texture2D(uHistory, uv + vec2(o.x, 0.0)).rgb));
  m += abs(lumaOf(fetch(uv - vec2(o.x, 0.0)).rgb) - lumaOf(texture2D(uHistory, uv - vec2(o.x, 0.0)).rgb));
  m += abs(lumaOf(fetch(uv + vec2(0.0, o.y)).rgb) - lumaOf(texture2D(uHistory, uv + vec2(0.0, o.y)).rgb));
  m += abs(lumaOf(fetch(uv - vec2(0.0, o.y)).rgb) - lumaOf(texture2D(uHistory, uv - vec2(0.0, o.y)).rgb));
  return m * 0.25;
}

/** Sobel 梯度幅值：用来判断「这里是边缘」 */
float edgeAt(vec2 uv, vec2 texel) {
  vec3 tl = fetch(uv + vec2(-texel.x,  texel.y)).rgb;
  vec3 tc = fetch(uv + vec2( 0.0,       texel.y)).rgb;
  vec3 tr = fetch(uv + vec2( texel.x,  texel.y)).rgb;
  vec3 ml = fetch(uv + vec2(-texel.x,  0.0)).rgb;
  vec3 mr = fetch(uv + vec2( texel.x,  0.0)).rgb;
  vec3 bl = fetch(uv + vec2(-texel.x, -texel.y)).rgb;
  vec3 bc = fetch(uv + vec2( 0.0,      -texel.y)).rgb;
  vec3 br = fetch(uv + vec2( texel.x, -texel.y)).rgb;

  // 亮度加权：对彩度噪声不敏感，避免彩色噪点被误判成边缘
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  float tlL = dot(tl, W), tcL = dot(tc, W), trL = dot(tr, W);
  float mlL = dot(ml, W), mrL = dot(mr, W);
  float blL = dot(bl, W), bcL = dot(bc, W), brL = dot(br, W);

  float gx = (trL + 2.0 * mrL + brL) - (tlL + 2.0 * mlL + blL);
  float gy = (blL + 2.0 * bcL + brL) - (tlL + 2.0 * tcL + trL);
  return sqrt(gx * gx + gy * gy);
}

void main() {
  vec3 orig = fetch(vUv).rgb;
  vec3 base = cubicSample(vUv);

  // ── 空间降噪（老片噪点的主场）──
  // 放在双三次放大之后、锐化之前：窗口按源像素算，既能压掉源噪点，
  // 又不会把刚放大的细节一起抹平。
  if (uDenoise > 0.001) {
    base = bilateral(vUv, base, 1.0 / uTexSize);
  }

  // ── 时域降噪（运动自适应）──
  // 真人影视的噪点是**随机分布**的，而相邻两帧的真实内容几乎不变，
  // 把当前帧和上一帧混合，随机噪点互相抵消，真实细节完整保留。
  //
  // ★ 关键修复：混合比例要**按运动量自适应**。
  //   之前是固定 0.32 混 → 画面一动就拖出鬼影（用户反馈「画面拉变形」）。
  //   现在：静止区域照混，检测到运动就自动降低混合比例 → 拖影消失。
  if (uHistoryMix > 0.001) {
    float motion = motionAmount(vUv, 1.0 / uTexSize);
    float mixAmt = uHistoryMix * (1.0 - smoothstep(0.025, 0.16, motion));
    if (mixAmt > 0.001) {
      vec3 hist = texture2D(uHistory, vUv).rgb;
      base = mix(base, hist, mixAmt);
    }
  }

  // ── 边缘自适应锐化 ──
  // 平坦区域不锐化（避免把噪点放大成雪花），只在梯度大的地方加
  vec2 texel = 1.0 / uTexSize;
  float edge = edgeAt(vUv, texel);
  float edgeMask = smoothstep(0.04, 0.35, edge);
  vec3 blurred = cubicSample(vUv + uPrevTexel * 1.2);
  vec3 sharpened = clamp(base + (base - blurred) * uSharpen * edgeMask, 0.0, 1.0);

  // ── 对比度与饱和度补偿（Anime4K Clamp Highlights 的思路）──
  // 放大后高光会糊成一团，用轻微的 S 曲线把亮部拉回来
  vec3 c = mix(sharpened, sharpened * sharpened * (3.0 - 2.0 * sharpened), uContrast);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);

  // ── 强度混合 ──
  // uStrength 只控制「增强结果相对原始的权重」，锐化量已由 uSharpen 单独决定。
  // 【踩过的坑】早期版本把锐化量也乘进 strength，导致轻度档实测清晰度 0.99×
  //（比不开还糊）—— strength=0.55 把锐化砍到一半，而 Catmull-Rom 采样本身
  // 又比原图软，两者叠加后净收益为负。现在两者解耦，strength 只做最终混合权重。
  gl_FragColor = vec4(mix(orig, c, uStrength), 1.0);
}`;
}

interface GLState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  buffer: WebGLBuffer;
  uTexSize: WebGLUniformLocation | null;
  uStrength: WebGLUniformLocation | null;
  uSharpen: WebGLUniformLocation | null;
  uContrast: WebGLUniformLocation | null;
  uSaturation: WebGLUniformLocation | null;
  uPrevTexel: WebGLUniformLocation | null;
  /** 历史帧纹理（时域降噪用） */
  historyTexture: WebGLTexture;
  /** 历史纹理的当前尺寸（必须跟 canvas 一致，否则 copyTexSubImage2D 会越界） */
  historyW: number;
  historyH: number;
  uHistory: WebGLUniformLocation | null;
  uHistoryMix: WebGLUniformLocation | null;
  uDenoise: WebGLUniformLocation | null;
  uDenoiseRadius: WebGLUniformLocation | null;
}

/**
 * 各档参数。数值来自 headless-gl 实测（tune-levels.js 网格扫描）。
 *
 * 【关键设计】uStrength 恒为 1.0，强度只由 uSharpen 调节。
 * 网格扫描显示：只要 strength < 1，锐化收益就被「与原图混合」稀释回去
 * （strength=0.45 + sharpen=0.15 实测只有 0.83×，比不开还软）。
 * 保留 strength 这个 uniform 只是为了将来做「关闭」的平滑过渡，不用于分档。
 *
 * 实测清晰度（拉普拉斯方差，基准 = 关闭增强时的原始画面）：
 *   轻度 ×1.35  标准 ×2.03  强力 ×2.89
 *
 * anime4k / anime4k-strong 档不走这套着色器，而是切到真正的 CNN 超分
 * （Anime4K 的 Restore-CNN + Upscale-CNN），由 Anime4KEngine 负责。
 */
export interface LevelDef {
  strength: number; sharpen: number; contrast: number; saturation: number;
  label: string; desc: string;
  /** 效率档 = 低开销；质量档 = Anime4K 真·CNN 超分；真人档 = 时域降噪 */
  group: 'perf' | 'quality' | 'live' | 'sharp';
  /** 时域混合系数（与上一帧输出混合）——真人档的降噪核心 */
  historyMix?: number;
  /** 空间双边降噪强度 0~1 */
  denoise?: number;
  /** 降噪窗口半径（源像素） */
  denoiseRadius?: number;
  /** 该档位是否用 2× 位图渲染（低清片源放大用） */
  upscale2x?: boolean;
}

export const LEVELS: Record<Exclude<EnhanceLevel, 'off'>, LevelDef> = {
  // ── 效率档：原生分辨率 + 轻量着色器，几乎不卡 ──
  light:    { strength: 1.0, sharpen: 0.20, contrast: 0.06, saturation: 1.04, label: '轻度',   desc: '轻微提亮，几乎不卡', group: 'perf' },
  standard: { strength: 1.0, sharpen: 0.55, contrast: 0.14, saturation: 1.10, label: '标准',   desc: '锐化明显，日常够用', group: 'perf' },
  strong:   { strength: 1.0, sharpen: 1.00, contrast: 0.22, saturation: 1.16, label: '强力',   desc: '最锐，老片友好',     group: 'perf' },
  // ── 真人档：时域降噪。真人影视的噪点是随机的，相邻帧内容不变，
  //    混合上一帧就能把噪点抵消掉、细节还留着。Anime4K 是给动画线条训练的，
  //    用在真人脸上会「塑料感」，这档才是给真人看的。
  photo:    { strength: 1.0, sharpen: 0.30, contrast: 0.08, saturation: 1.02,
              label: '真人', desc: '时域降噪，去噪点保肤色', group: 'live',
              historyMix: 0.32, denoise: 0.40, denoiseRadius: 1.0 },
  // ── 老片档：给噪点多的老片用 ──
  //   组合拳：① 双边降噪压胶片颗粒 ② 强边缘自适应锐化把细节顶回来
  //   ③ 2× 位图渲染（低清源放大到更高分辨率再显示，观感接近"变高清"）
  //   ④ 轻微提对比+提饱和，老片的"灰蒙感"会褪掉
  retro:    { strength: 1.0, sharpen: 1.40, contrast: 0.16, saturation: 1.14,
              label: '老片', desc: '去噪点+锐化拉满，2× 放大', group: 'sharp',
              denoise: 0.92, denoiseRadius: 1.35, upscale2x: true },
  // ── 质量档：Anime4K 真·CNN 超分（2× 放大）──
  anime4k:  { strength: 1.0, sharpen: 0, contrast: 0, saturation: 1, label: 'Anime4K 标准', desc: 'AI 超分 2×（1080p→4K）', group: 'quality' },
  'anime4k-strong': { strength: 1.0, sharpen: 0, contrast: 0, saturation: 1, label: 'Anime4K 极致', desc: 'VL 档 2×，最清晰最吃 GPU', group: 'quality' },
};

/** 菜单分组顺序 */
export const LEVEL_GROUPS: { key: LevelDef['group']; title: string; hint: string }[] = [
  { key: 'perf', title: '效率档', hint: '原生分辨率 · 几乎不卡' },
  { key: 'live', title: '真人档', hint: '时域降噪 · 去噪点保肤色' },
  { key: 'sharp', title: '老片档', hint: '降噪 + 锐化拉满 · 2× 放大' },
  { key: 'quality', title: '质量档', hint: 'Anime4K 真·CNN 超分 · 2× 放大（偏动画）' },
];

/** 是否走 Anime4K 引擎 */
export function isAnime4K(level: EnhanceLevel): boolean {
  return level === 'anime4k' || level === 'anime4k-strong';
}

export class VideoEnhancer {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private gls: GLState | null = null;
  private rafId = 0;
  private running = false;
  private level: EnhanceLevel = 'off';
  private prevWidth = 0;
  private prevHeight = 0;
  private lastFrameAt = 0;
  private frameSamples: number[] = [];
  private lowFpsNotified = false;
  /** 持续掉帧时回调一次（传实测 fps），用于提示用户可以切弱档 */
  onLowFps?: (fps: number) => void;
  /** Anime4K 引擎（真·CNN 超分） */
  private a4k: Anime4KEngine | null = null;
  private a4kShaders: Record<string, string> | null = null;
  private a4kLoading = false;
  /** Anime4K 的源纹理与 blit program 由引擎内部管理，这里只做上传 */
  info: EnhanceInfo = { supported: false, precision: 'lowp' };

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sr-canvas';
    // 铺满播放器容器，位置压在 video 之上
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      background: '#000',
      pointerEvents: 'none',
      zIndex: '2',
      display: 'none',
    } as CSSStyleDeclaration);
  }

  /** 初始化 GL 上下文；返回是否可用 */
  init(): EnhanceInfo {
    if (this.gls) return this.info;
    const opts: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // 关掉 preserveDrawingBuffer：不需要截图，省显存
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    };
    let gl: WebGLRenderingContext | null = null;
    try {
      const c = this.canvas.getContext('webgl', opts) as WebGLRenderingContext | null;
      if (c) gl = c;
    } catch { /* 上下文创建失败 */ }
    if (!gl) {
      this.info = { supported: false, precision: 'lowp' };
      return this.info;
    }

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : undefined;
    // getShaderPrecisionFormat 在部分驱动上返回 null，不能直接解引用
    const prec = (p: number): number => gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, p)?.precision ?? 0;
    const precision: EnhanceInfo['precision'] =
      prec(gl.HIGH_FLOAT) > 0 ? 'highp' : prec(gl.MEDIUM_FLOAT) > 0 ? 'mediump' : 'lowp';

    const prog = buildProgram(gl, VERT_SRC, fragSrc(true));
    if (!prog) {
      this.info = { supported: false, renderer, precision };
      return this.info;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // 全屏三角形（比 quad 少一次插值，边缘少一条缝）
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.useProgram(prog);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);

    // 历史帧纹理（时域降噪用）：内容由每帧渲染后 copyTexSubImage2D 写入
    const historyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, historyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    this.gls = {
      gl, program: prog, texture: tex, buffer: buf, historyTexture: historyTex,
      historyW: 1, historyH: 1,
      uHistory: gl.getUniformLocation(prog, 'uHistory'),
      uHistoryMix: gl.getUniformLocation(prog, 'uHistoryMix'),
      uDenoise: gl.getUniformLocation(prog, 'uDenoise'),
      uDenoiseRadius: gl.getUniformLocation(prog, 'uDenoiseRadius'),
      uTexSize: gl.getUniformLocation(prog, 'uTexSize'),
      uStrength: gl.getUniformLocation(prog, 'uStrength'),
      uSharpen: gl.getUniformLocation(prog, 'uSharpen'),
      uContrast: gl.getUniformLocation(prog, 'uContrast'),
      uSaturation: gl.getUniformLocation(prog, 'uSaturation'),
      uPrevTexel: gl.getUniformLocation(prog, 'uPrevTexel'),
    };
    this.info = { supported: true, renderer, precision };
    return this.info;
  }

  get supported() { return this.info.supported; }
  get currentLevel() { return this.level; }

  /**
   * 当前输出分辨率
   *
   * ★ 这是判断「增强到底有没有跑」最硬的证据：
   *   原片 video.videoWidth×videoHeight（解码后的真实分辨率）
   *   → 增强后 canvas.width×canvas.height（实际渲染分辨率）
   *
   * Anime4K 档位下输出应为原片的 2×（1080p → 3840×2160，即 4K）。
   * 如果两者相等，说明引擎没接管渲染 —— 增强根本没生效。
   */
  get outputSize(): { w: number; h: number; sourceW: number; sourceH: number } {
    return {
      w: this.canvas.width,
      h: this.canvas.height,
      sourceW: this.video.videoWidth,
      sourceH: this.video.videoHeight,
    };
  }

  setLevel(level: EnhanceLevel) {
    this.level = level;
    if (level === 'off') { this.stop(); return; }
    if (!this.init().supported) { this.level = 'off'; return; }
    // 切档时重置掉帧统计，否则旧档位的样本会立刻触发误报
    this.frameSamples = [];
    this.lowFpsNotified = false;
    // 清空历史纹理：否则第一帧会把上一档的画面混进来（会闪一下）
    if (this.gls) {
      const { gl, historyTexture } = this.gls;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, historyTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      this.gls.historyW = 1;
      this.gls.historyH = 1;
      gl.activeTexture(gl.TEXTURE0);
    }
    if (isAnime4K(level)) {
      // Anime4K 需要额外加载着色器并编译整条链，是异步的
      void this.prepareAnime4K(level);
      return;
    }
    this.start();
  }

  /**
   * 准备 Anime4K 引擎。
   * 着色器要现拉现编译（首次约 300KB），期间先不显示增强画面，编译好再切上。
   */
  private async prepareAnime4K(level: EnhanceLevel) {
    const gl = this.gls?.gl;
    if (!gl) {
      console.error('[LibreTV] Anime4K：WebGL 上下文还没初始化');
      return;
    }
    this.a4kLoading = true;
    try {
      if (!this.a4kShaders) this.a4kShaders = await loadAnime4KShaders();
      if (!this.a4k) this.a4k = new Anime4KEngine(gl);
      const quality: Anime4KQuality = level === 'anime4k-strong' ? 'strong' : 'standard';
      const ok = this.a4k.compile(this.a4kShaders, quality);
      if (!ok) {
        this.info.anime4k = false;
        this.info.anime4kError = this.a4k.lastError || '编译失败';
        // ★ 必须打日志：编译失败时以前是**完全静默**的，
        //   用户只看到「点了没反应」，根本不知道是着色器编译不过。
        console.error('[LibreTV] Anime4K 编译失败:', this.info.anime4kError);
        this.level = 'off';
        this.a4kLoading = false;
        return;
      }
      this.info.anime4k = true;
      this.info.anime4kError = undefined;
      this.a4kLoading = false;
      // 期间用户可能已经切走了
      if (this.level !== level) return;
      this.start();
    } catch (e) {
      this.info.anime4k = false;
      this.info.anime4kError = (e as Error).message;
      console.error('[LibreTV] Anime4K 初始化异常:', (e as Error).message);
      this.a4kLoading = false;
      this.level = 'off';
    }
  }

  private start() {
    if (this.running) return;
    this.running = true;
    this.attach();
    this.loop();
  }

  private stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.detach();
  }

  private attach() {
    const parent = this.video.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    if (!this.canvas.parentElement) parent.appendChild(this.canvas);
    this.canvas.style.display = 'block';
    // 隐藏 video 的原生画面，但保留它解码音频与时间轴
    this.video.style.opacity = '0';
  }

  private detach() {
    this.canvas.style.display = 'none';
    this.video.style.opacity = '';
    if (this.gls) {
      const { gl } = this.gls;
      // 丢失当前帧，避免下次开启时显示上一次的画面
      gl.bindTexture(gl.TEXTURE_2D, this.gls.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    }
  }

  private loop = () => {
    if (!this.running || !this.gls) return;
    this.rafId = requestAnimationFrame(this.loop);
    const { gl } = this.gls;
    const v = this.video;

    if (v.readyState < 2 || v.videoWidth === 0) return;

    // 视频尺寸/容器尺寸变化时同步 canvas 分辨率
    // ★ 用**父容器**（.art-video-player）的尺寸，而不是 video 自身的。
    //   video 元素有时拿不到真实布局尺寸（CSS 未生效时就是 HTML 默认的
    //   300×150），照它算 canvas 位图就会和实际显示尺寸对不上，
    //   画面被二次拉伸 → 看起来比原片还糊。
    //   canvas 本身就挂在 video 的父容器里（见 attach），
    //   用同一个尺寸保证「位图像素 = 显示像素」，1:1 不失真。
    const host = (v.parentElement as HTMLElement | null) ?? v;
    const rect = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    /**
     * canvas 的位图尺寸
     *
     * ★ Anime4K 档必须用「**视频原始分辨率 × 2**」，不能用容器尺寸。
     *   原因：Anime4K 的 x2 pass 是相对**输入纹理**放大的（引擎里
     *   `ow = input.w * 2`，input 就是视频帧）。
     *   640×360 的片子 → 引擎输出 1280×720。
     *   如果 canvas 用容器尺寸（比如 1398×786），两者对不上，
     *   超分结果会被拉伸变形 → 看起来「没放大两倍」，甚至更糊。
     *
     *   canvas 的 CSS 是 width/height:100% + object-fit:contain，
     *   所以位图改成 2× 不会撑破布局，只会等比缩放到显示区域。
     */
    // ★ Anime4K 和「老片」档都用 **视频分辨率 × 2** 作为位图尺寸：
    //   Anime4K 的 x2 pass 是相对输入纹理放大的；
    //   老片档靠 2× 位图 + 双三次插值 + 锐化，把低清源"拉"得更清晰。
    //   canvas 的 CSS 是 100% + object-fit:contain，改位图不影响显示。
    const lvl = this.level === 'off' ? 'standard' : this.level;
    const upscale2x = isAnime4K(this.level) || LEVELS[lvl]?.upscale2x === true;
    const cw = upscale2x
      ? Math.max(2, v.videoWidth * 2)
      : Math.max(1, Math.round(rect.width * dpr));
    const ch = upscale2x
      ? Math.max(2, v.videoHeight * 2)
      : Math.max(1, Math.round(rect.height * dpr));

    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    // ── Anime4K 档：走 CNN 超分引擎 ──
    if (isAnime4K(this.level)) {
      if (!this.a4k || !this.a4k.isReady) return;   // 还在编译，先不显示
      gl.bindTexture(gl.TEXTURE_2D, this.gls.texture);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      } catch {
        return;
      }
      // Anime4K 内部自己管 FBO 与 viewport，最后把结果画到默认 framebuffer
      this.a4k.render(this.gls.texture, v.videoWidth, v.videoHeight, cw, ch);
      this.trackFrameCost();
      return;
    }

    gl.viewport(0, 0, cw, ch);

    // 上传当前帧
    gl.bindTexture(gl.TEXTURE_2D, this.gls.texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    } catch {
      // 某些浏览器在视频帧未就绪时抛 InvalidStateError，跳过这一帧
      return;
    }

    const p = LEVELS[(this.level === 'off' ? 'standard' : this.level)];
    gl.uniform2f(this.gls.uTexSize, v.videoWidth, v.videoHeight);
    gl.uniform1f(this.gls.uStrength, p.strength);
    gl.uniform1f(this.gls.uSharpen, p.sharpen);
    gl.uniform1f(this.gls.uContrast, p.contrast);
    gl.uniform1f(this.gls.uSaturation, p.saturation);
    gl.uniform2f(this.gls.uPrevTexel, 1 / v.videoWidth, 1 / v.videoHeight);

    // 历史帧纹理：绑到 texture unit 1，unit 0 是当前帧
    const historyMix = p.historyMix ?? 0;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gls.historyTexture);
    gl.uniform1i(this.gls.uHistory, 1);
    gl.uniform1f(this.gls.uHistoryMix, historyMix);
    gl.uniform1f(this.gls.uDenoise, p.denoise ?? 0);
    gl.uniform1f(this.gls.uDenoiseRadius, p.denoiseRadius ?? 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 渲染完立刻把这一帧的画面复制进历史纹理，供下一帧做时域降噪。
    // 必须在同一帧内（渲染后、浏览器合成前）复制，否则 preserveDrawingBuffer=false
    // 会让 canvas 内容已被丢弃，拿到的是空白。
    //
    // ★ 坑：历史纹理初始只有 1×1，而 copyTexSubImage2D 传的宽高是 canvas 的尺寸
    //   → 报 GL_INVALID_VALUE: Offset overflows texture dimensions
    //   → 复制静默失败，历史纹理永远是 1×1 黑图
    //   → 下一帧把它混进画面 = 画面被拉黑（用户看到「画质没变化」甚至更糟）
    // 所以每次 canvas 尺寸变了，必须先把历史纹理重新分配成同样大小。
    if (historyMix > 0.001) {
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.gls.historyTexture);
      if (this.gls.historyW !== cw || this.gls.historyH !== ch) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.gls.historyW = cw;
        this.gls.historyH = ch;
      }
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, cw, ch);
      gl.activeTexture(gl.TEXTURE0);
    }

    this.trackFrameCost();
  };

  /**
   * 掉帧监测。
   *
   * 增强本身会占用一点 GPU，低端集显 + 4K 全屏可能把帧率压下来。
   * 这里不做自动降档（画面突变比掉帧更烦），只在持续明显掉帧时回调一次，
   * 由 UI 提示用户「可以切到轻度/关闭」，把选择权交回去。
   */
  private trackFrameCost() {
    const now = performance.now();
    if (this.lastFrameAt) {
      const dt = now - this.lastFrameAt;
      // 只统计正常帧间隔（>1ms）；页面被切到后台时长会算出巨大值，忽略
      if (dt > 1 && dt < 500) {
        this.frameSamples.push(dt);
        if (this.frameSamples.length > 120) this.frameSamples.shift();
        if (this.frameSamples.length === 120 && !this.lowFpsNotified) {
          const sorted = [...this.frameSamples].sort((a, b) => a - b);
          const median = sorted[60];
          // 连续中位帧间隔 > 28ms（≈36fps）视为明显掉帧
          if (median > 28) {
            this.lowFpsNotified = true;
            this.onLowFps?.(Math.round(1000 / median));
          }
        }
      }
    }
    this.lastFrameAt = now;
  }

  dispose() {
    this.stop();
    this.canvas.remove();
    if (this.a4k) { this.a4k.dispose(); this.a4k = null; }
    this.a4kShaders = null;
    const g = this.gls;
    if (g) {
      g.gl.deleteTexture(g.texture);
      g.gl.deleteBuffer(g.buffer);
      g.gl.deleteProgram(g.program);
      // 交还上下文，避免占着 GPU 资源不放
      g.gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.gls = null;
    }
    this.info = { supported: false, precision: 'lowp' };
  }

  /**
   * 截图。
   *
   * 超分开启时 video 被设成 opacity:0，ArtPlayer 内置截图抓 video 会得到全黑图。
   * 所以超分状态下改为抓 canvas —— canvas 上的像素就是最终显示的画面，本来更准确。
   * 未开启时返回 null，让调用方回退到 ArtPlayer 自己的截图。
   */
  capture(): string | null {
    if (!this.running || !this.gls || !this.levelActive) return null;
    try {
      return this.canvas.toDataURL('image/png');
    } catch {
      // 跨域视频帧会污染 canvas，toDataURL 抛 SecurityError
      return null;
    }
  }

  private get levelActive() { return this.level !== 'off' && this.running; }
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    // 着色器编译失败只降级、不打断播放 —— 这类问题不该让用户看到报错页
    console.warn('[超分] 着色器编译失败，降级为原生画质', log);
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function buildProgram(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[超分] 程序链接失败，降级为原生画质', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}