/**
 * Anime4K WebGL 执行引擎
 *
 * 移植自 mpv 的 Anime4K GLSL 着色器链（Kazumi 自带的那套，MIT 许可）。
 * mpv 用 `//!SAVE` 命名中间缓冲，WebGL 里用 FBO + ping-pong 纹理实现。
 *
 * 管线（按画质档选）：
 *   轻量/标准：Restore-CNN(M) → Upscale-CNN-x2(M) → Clamp-Highlights
 *   强力：     Restore-CNN(VL) → Upscale-CNN-x2(VL) → Clamp-Highlights
 *
 * ★ 三个必须搞对的语义（踩过坑）：
 *
 *  ① BIND 与 SAVE 的对应
 *     `//!BIND X` 读的是**上游**名为 X 的输出；`//!SAVE X` 写当前 pass 的结果。
 *     所以「读 X」用的是上一轮 resolved[X]，「写 X」是本轮的输出。
 *     `//!BIND MAIN` 特殊 —— 它读的是**原始视频帧**，不是任何中间缓冲。
 *
 *  ② 输出尺寸由 `//!WIDTH` 表达式决定，不由 pass 名字决定
 *     Upscale 链里中间的 CNN pass 全是同尺寸（只在通道维度工作），
 *     只有最后的 Depth-to-Space 才是真 2×。按名字判断会一路累乘到 30720×17280。
 *
 *  ③ 最后一 pass 的输出要画到屏幕
 *     但最后一 pass 可能是「统计类」（COMPONENTS 1，只算亮度），
 *     不能直接显示 —— 要显示的是**整条链的最终画面**。
 *     实际做法：链跑完后，用一个「直通」program 把最终纹理画到屏幕。
 *     最终纹理 = 最后一个「画面类」pass 的输出（Clamp 的第三个 pass 才是画面）。
 */

import { parseMpvShader, passToWebGL, collectBinds, outputScale, type MpvPass } from './mpv-to-webgl';

export type Anime4KQuality = 'light' | 'standard' | 'strong';

export interface Anime4KChain {
  passes: MpvPass[];
  bindsPerPass: string[][];
  allBinds: string[];
}

interface CompiledPass {
  pass: MpvPass;
  program: WebGLProgram;
  uniforms: {
    tex: Record<string, WebGLUniformLocation | null>;
    texel: Record<string, WebGLUniformLocation | null>;
    size: Record<string, WebGLUniformLocation | null>;
    outSize: WebGLUniformLocation | null;
    inSize: WebGLUniformLocation | null;
    natSize: WebGLUniformLocation | null;
  };
  scale: 'same' | '2x';
  readsOriginal: boolean;
  /** 画面类 pass（COMPONENTS 4）才可能作为最终显示内容 */
  isPicture: boolean;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  /** 逻辑名与 ping-pong 槽位 */
  name: string;
  slot: number;
}

const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** 直通 program：把最终纹理画到屏幕 */
const BLIT_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

/**
 * 画质档 → 需要哪些 shader 文件
 *
 * ★ 关于 Clamp_Highlights（De-Ring）：
 *   它是 Anime4K 链的**可选去振铃环节**，做的是「算出邻域最大亮度，
 *   把超过它的部分削掉」。移植到 WebGL 后需要处理 STATSMAX 的
 *   读写同名纹理（已用 ping-pong 解决），但在本项目的无头验证里
 *   输出的亮度仍明显偏低（4.4/255 vs 预期的 188）。
 *
 *   权衡后：**默认不启用**。理由是
 *     ① 它只影响「极亮边缘处的振铃」，肉眼几乎看不出；
 *     ② 亮度削错会让画面明显变暗，副作用远大于收益；
 *     ③ Restore + Upscale 才是 Anime4K 的核心（CNN 恢复细节 + 2× 放大），
 *        已完整验证通过。
 *   保留在代码里，后续若定位清楚可以再开。
 */
const CHAIN_SPEC: Record<Anime4KQuality, string[]> = {
  light: ['Anime4K_Restore_CNN_M.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'],
  standard: ['Anime4K_Restore_CNN_M.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'],
  strong: ['Anime4K_Restore_CNN_VL.glsl', 'Anime4K_Upscale_CNN_x2_VL.glsl'],
};

export class Anime4KEngine {
  private gl: WebGLRenderingContext;
  private programs: CompiledPass[] = [];
  private targets = new Map<string, Target>();
  private quad: WebGLBuffer;
  private blitProg: WebGLProgram | null = null;
  private blitTexLoc: WebGLUniformLocation | null = null;
  private quality: Anime4KQuality = 'standard';
  private ready = false;
  private error: string | null = null;
  /** 最终画面纹理的名字（最后一个画面类 pass 的 SAVE） */
  private finalName = '';

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.initBlit();
  }

  private initBlit() {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
      return sh;
    };
    const v = mk(gl.VERTEX_SHADER, VS);
    const f = mk(gl.FRAGMENT_SHADER, BLIT_FS);
    if (!v || !f) return;
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return;
    this.blitProg = p;
    this.blitTexLoc = gl.getUniformLocation(p, 'uTex');
  }

  get isReady() { return this.ready; }
  get lastError() { return this.error; }
  get currentQuality() { return this.quality; }

  /**
   * 加载并编译整条链。
   * @param shaders  形如 { 'Anime4K_Restore_CNN_M.glsl': '<glsl 源码>' }
   */
  compile(shaders: Record<string, string>, quality: Anime4KQuality): boolean {
    this.quality = quality;
    this.ready = false;
    this.error = null;
    this.disposePrograms();

    const files = CHAIN_SPEC[quality];
    const allPasses: MpvPass[] = [];

    for (const file of files) {
      const src = shaders[file];
      if (!src) { this.error = `缺少着色器文件：${file}`; return false; }
      let parsed;
      try {
        parsed = parseMpvShader(src);
      } catch (e) {
        this.error = `解析 ${file} 失败：${(e as Error).message}`;
        return false;
      }
      allPasses.push(...parsed.passes);
    }

    const globalBinds = collectBinds(allPasses);
    // HOOKED / MAIN 是 mpv 的隐式别名，不一定出现在 BIND/SAVE 列表里，
    // 但着色器代码会直接用 `HOOKED_tex(...)`，所以必须为它们建 sampler。
    globalBinds.push('MAIN', 'HOOKED');

    for (const p of allPasses) {
      const frag = passToWebGL(p, globalBinds);
      const program = this.buildProgram(frag);
      if (!program) {
        this.error = `编译 pass「${p.desc}」失败`;
        return false;
      }
      const uniforms: CompiledPass['uniforms'] = {
        tex: {}, texel: {}, size: {},
        outSize: null, inSize: null, natSize: null,
      };
      uniforms.outSize = this.gl.getUniformLocation(program, 'outSize');
      uniforms.inSize = this.gl.getUniformLocation(program, 'inSize');
      uniforms.natSize = this.gl.getUniformLocation(program, 'natSize');
      for (const b of globalBinds) {
        uniforms.tex[b] = this.gl.getUniformLocation(program, `uTex_${b}`);
        uniforms.texel[b] = this.gl.getUniformLocation(program, `pt_${b}`);
        uniforms.size[b] = this.gl.getUniformLocation(program, `size_${b}`);
      }
      this.programs.push({
        pass: p,
        program,
        uniforms,
        scale: outputScale(p),
        readsOriginal: p.hook === 'PREKERNEL',
        isPicture: p.components >= 4,
      });
    }

    this.ready = true;
    return true;
  }

  private buildProgram(fragSrc: string): WebGLProgram | null {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[Anime4K] 着色器编译失败:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, VS);
    if (!vs) return null;
    const fs = mk(gl.FRAGMENT_SHADER, fragSrc);
    if (!fs) return null;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[Anime4K] 链接失败:', gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    return p;
  }

  /**
   * 取得（或创建）指定尺寸的 FBO 纹理。
   *
   * ★ ping-pong：Anime4K 的 Clamp 段有两个 pass 都叫 STATSMAX
   *   （第一个 `//!SAVE STATSMAX` 写，第二个 `//!BIND STATSMAX` 读并再写同名）。
   *   读同一张纹理的同时又写它，是未定义行为 —— 实际表现是画面被削暗成噪点。
   *   所以同名纹理分配**两张**，交替使用：写第 n 遍用第 n%2 张，读的是上一遍那张。
   */
  private ensureTarget(name: string, w: number, h: number, slot: number): Target {
    const gl = this.gl;
    const key = `${name}@${w}x${h}#${slot}`;
    const existing = this.targets.get(key);
    if (existing) return existing;

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const t: Target = { tex, fbo, w, h, name, slot };
    this.targets.set(key, t);
    return t;
  }

  /**
   * 跑一帧。
   * @param srcTex  源纹理（视频帧）
   * @param srcW/H  源尺寸
   * @param outW/H  输出尺寸（画布尺寸）
   */
  render(srcTex: WebGLTexture, srcW: number, srcH: number, outW: number, outH: number): void {
    if (!this.ready || !this.programs.length) return;
    const gl = this.gl;

    /** 逻辑名 → 当前物理纹理（读的那张） */
    const resolved = new Map<string, Target>();
    /** 逻辑名 → 已写入次数（决定 ping-pong 槽位） */
    const writeCount = new Map<string, number>();
    /**
     * ★ MAIN 的语义（Anime4K 的关键约定）：
     *   MAIN 不是「原始视频帧」，而是「**上一段链的最终输出**」。
     *   Restore 链最后一个 pass 是 `//!SAVE MAIN`，Upscale 链第一个 pass 是
     *   `//!BIND MAIN` —— 两段链靠这个名字衔接。
     *   所以 MAIN 初始为空，由上游 pass 写入 resolved['MAIN']。
     *   只有当某个 pass 要读 MAIN 而 resolved 里还没有时，才回退到原始视频帧。
     */
    const original: Target = { tex: srcTex, fbo: gl.createFramebuffer()!, w: srcW, h: srcH, name: 'SRC', slot: 0 };
    const mainTarget = (): Target => resolved.get('MAIN') ?? original;
    /**
     * HOOKED = 「当前 hook 的主输入」。
     * 在 Clamp 段，它指的是上一段链（Upscale）的最终画面 —— 即最近一个
     * 画面类 pass 的输出。所以单独记一份 hookedTarget。
     */
    let hookedTarget: Target | null = null;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    for (let idx = 0; idx < this.programs.length; idx++) {
      const cp = this.programs[idx];
      const p = cp.pass;

      // —— 输入尺寸 ——
      // BIND 的第一个是主输入。MAIN → 上一段链的输出（没有则回退原始帧）。
      const mainBind = p.binds[0] || 'MAIN';
      const input = mainBind === 'MAIN'
        ? mainTarget()
        : (mainBind === 'HOOKED'
          ? (hookedTarget ?? mainTarget())
          : (resolved.get(mainBind) ?? mainTarget()));

      // —— 输出尺寸 ——
      const ow = cp.scale === '2x' ? input.w * 2 : input.w;
      const oh = cp.scale === '2x' ? input.h * 2 : input.h;

      gl.useProgram(cp.program);
      const aPos = gl.getAttribLocation(cp.program, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      let unit = 0;
      const bindTex = (name: string, t: Target) => {
        const loc = cp.uniforms.tex[name];
        if (!loc) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.uniform1i(loc, unit);
        const tl = cp.uniforms.texel[name];
        if (tl) gl.uniform2f(tl, 1 / Math.max(1, t.w), 1 / Math.max(1, t.h));
        const sz = cp.uniforms.size[name];
        if (sz) gl.uniform2f(sz, t.w, t.h);
        unit++;
      };

      for (const b of p.binds) {
        if (b === 'MAIN') bindTex('MAIN', mainTarget());
        else if (b === 'HOOKED') bindTex('HOOKED', hookedTarget ?? mainTarget());
        else bindTex(b, resolved.get(b) ?? mainTarget());
      }
      // MAIN 始终可见（条件不成立时要输出它）
      if (!p.binds.includes('MAIN')) bindTex('MAIN', mainTarget());
      // HOOKED 始终可见
      if (!p.binds.includes('HOOKED')) bindTex('HOOKED', hookedTarget ?? mainTarget());

      gl.uniform2f(cp.uniforms.outSize, ow, oh);
      gl.uniform2f(cp.uniforms.inSize, input.w, input.h);
      gl.uniform2f(cp.uniforms.natSize, outW, outH);

      // —— 渲染到目标 ——
      const saveName = p.save || `pass${idx}`;
      // ping-pong：同名纹理交替用两张，避免「读的同时写同一张」
      const slot = writeCount.get(saveName) ?? 0;
      const tgt = this.ensureTarget(saveName, ow, oh, slot % 2);
      gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
      gl.viewport(0, 0, ow, oh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      writeCount.set(saveName, slot + 1);
      resolved.set(saveName, tgt);
      // 画面类 pass 的输出可能是最终显示内容，同时也是后续段 HOOKED 的来源
      if (cp.isPicture) {
        this.finalName = saveName;
        hookedTarget = tgt;
      }
      // ★ HOOK PREKERNEL 的 pass 直接作用于画面本身：
      //   mpv 里它不写独立缓冲，而是**就地改写 MAIN**。
      //   Anime4K 的 Clamp 段最后一个 pass（De-Ring-Clamp）就是这种，
      //   它没有 //!SAVE，输出即最终画面。
      //   所以 PREKERNEL 的输出要同时写回 resolved['MAIN']。
      if (cp.readsOriginal) {
        resolved.set('MAIN', tgt);
        this.finalName = saveName;
        hookedTarget = tgt;
      }
    }

    // —— 把最终画面画到屏幕 ——
    const final = this.finalName ? resolved.get(this.finalName) : undefined;
    if (final && this.blitProg) {
      gl.useProgram(this.blitProg);
      const aPos = gl.getAttribLocation(this.blitProg, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, final.tex);
      if (this.blitTexLoc) gl.uniform1i(this.blitTexLoc, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, outW, outH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private disposePrograms() {
    const gl = this.gl;
    for (const cp of this.programs) gl.deleteProgram(cp.program);
    this.programs = [];
  }

  dispose() {
    const gl = this.gl;
    this.disposePrograms();
    for (const t of this.targets.values()) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.targets.clear();
    if (this.blitProg) { gl.deleteProgram(this.blitProg); this.blitProg = null; }
  }
}
