/**
 * mpv → WebGL 转换器的单元测试
 *
 * 转换逻辑是纯函数，可以脱离浏览器测。
 */
import { describe, it, expect } from 'vitest';
import { parseMpvShader, passToWebGL, collectBinds, outputScale } from './mpv-to-webgl';

const SAMPLE = `//!DESC Anime4K-v4.0-Restore-CNN-(M)-Conv-4x3x3x3
//!HOOK MAIN
//!BIND MAIN
//!SAVE conv2d_tf
//!WIDTH MAIN.w
//!HEIGHT MAIN.h
//!COMPONENTS 4
#define go_0(x_off, y_off) (MAIN_texOff(vec2(x_off, y_off)))
vec4 hook() {
    vec4 result = mat4(1.0) * go_0(-1.0, -1.0);
    result += vec4(0.5);
    return result;
}
//!DESC Anime4K-v4.0-Restore-CNN-(M)-Conv-4x3x3x8
//!HOOK MAIN
//!BIND conv2d_tf
//!SAVE conv2d_1_tf
//!WIDTH conv2d_tf.w
//!HEIGHT conv2d_tf.h
//!COMPONENTS 4
vec4 hook() {
    return MAIN_tex(HOOKED_pos);
}
//!DESC Anime4K-v3.2-Upscale-CNN-x2-(M)-Conv-4x3x3x3
//!HOOK MAIN
//!BIND MAIN
//!SAVE conv2d_tf
//!WIDTH conv2d_tf.w
//!HEIGHT conv2d_tf.h
//!COMPONENTS 4
//!WHEN OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *
vec4 hook() { return MAIN_texOff(vec2(0.0, 0.0)); }`;

describe('parseMpvShader', () => {
  it('按 //!DESC 切分出多个 pass', () => {
    const { passes } = parseMpvShader(SAMPLE);
    expect(passes).toHaveLength(3);
    expect(passes[0].desc).toContain('Restore-CNN-(M)-Conv-4x3x3x3');
    expect(passes[2].desc).toContain('Upscale-CNN-x2');
  });

  it('解析 BIND / SAVE / COMPONENTS', () => {
    const { passes } = parseMpvShader(SAMPLE);
    expect(passes[0].binds).toEqual(['MAIN']);
    expect(passes[0].save).toBe('conv2d_tf');
    expect(passes[0].components).toBe(4);
    expect(passes[1].binds).toEqual(['conv2d_tf']);
    expect(passes[1].save).toBe('conv2d_1_tf');
  });

  it('解析 //!WHEN 条件', () => {
    const { passes } = parseMpvShader(SAMPLE);
    expect(passes[2].when).toBeTruthy();
    expect(passes[2].when).toContain('OUTPUT.w');
  });

  it('hook() 包装被保留在 body 里', () => {
    const { passes } = parseMpvShader(SAMPLE);
    expect(passes[0].body).toContain('vec4 hook()');
    expect(passes[0].body).toContain('go_0');
  });
});

describe('collectBinds', () => {
  it('收集所有 BIND 与 SAVE 名', () => {
    const { passes } = parseMpvShader(SAMPLE);
    const binds = collectBinds(passes);
    expect(binds).toContain('MAIN');
    expect(binds).toContain('conv2d_tf');
    expect(binds).toContain('conv2d_1_tf');
  });
});

describe('outputScale', () => {
  it('WIDTH 表达式带系数时输出 2 倍尺寸', () => {
    // 真实 Anime4K 里只有 Depth-to-Space 才是真 2×：
    //   //!WIDTH conv2d_last_tf.w 2 *
    const { passes } = parseMpvShader(`
//!DESC Upscale-Depth-to-Space
//!HOOK MAIN
//!BIND MAIN
//!SAVE MAIN
//!WIDTH conv2d_last_tf.w 2 *
//!HEIGHT conv2d_last_tf.h 2 *
//!COMPONENTS 4
vec4 hook() { return MAIN_tex(MAIN_pos); }`);
    expect(outputScale(passes[0])).toBe('2x');
  });
  it('WIDTH 表达式无系数时输出同尺寸', () => {
    // ★ 不能按 pass 名字判断：Upscale 链里中间的 CNN pass 全是同尺寸，
    //   它们只在通道维度工作。
    const { passes } = parseMpvShader(`
//!DESC Upscale-CNN-x2-(M)-Conv-4x3x3x8
//!HOOK MAIN
//!BIND conv2d_tf
//!SAVE conv2d_1_tf
//!WIDTH conv2d_tf.w
//!HEIGHT conv2d_tf.h
//!COMPONENTS 4
vec4 hook() { return MAIN_tex(MAIN_pos); }`);
    expect(outputScale(passes[0])).toBe('same');
  });
  it('MAIN.w 2 * 形式也判为 2x', () => {
    const { passes } = parseMpvShader(`
//!DESC AutoDownscalePre-x2
//!HOOK MAIN
//!BIND MAIN
//!SAVE MAIN
//!WIDTH MAIN.w 2 *
//!HEIGHT MAIN.h 2 *
//!COMPONENTS 4
vec4 hook() { return MAIN_tex(MAIN_pos); }`);
    expect(outputScale(passes[0])).toBe('2x');
  });
});

describe('passToWebGL', () => {
  it('hook() 改写成 main()', () => {
    const { passes } = parseMpvShader(SAMPLE);
    const glsl = passToWebGL(passes[0], ['MAIN', 'conv2d_tf']);
    expect(glsl).toContain('void main()');
    expect(glsl).not.toContain('vec4 hook()');
  });

  it('MAIN_texOff 转成 texOff_MAIN 采样', () => {
    const { passes } = parseMpvShader(SAMPLE);
    const glsl = passToWebGL(passes[0], ['MAIN', 'conv2d_tf']);
    expect(glsl).toContain('texOff_MAIN');
    expect(glsl).not.toContain('MAIN_texOff');
  });

  it('为每个可见纹理生成 sampler uniform', () => {
    const { passes } = parseMpvShader(SAMPLE);
    const glsl = passToWebGL(passes[0], ['MAIN', 'conv2d_tf']);
    expect(glsl).toContain('uniform sampler2D uTex_MAIN;');
    expect(glsl).toContain('uniform sampler2D uTex_conv2d_tf;');
  });

  it('//!WHEN 条件改写成 outW/outH/inW/inH 并包成 if', () => {
    const { passes } = parseMpvShader(SAMPLE);
    const glsl = passToWebGL(passes[2], ['MAIN', 'conv2d_tf']);
    expect(glsl).toContain('outW');
    expect(glsl).toContain('inW');
    expect(glsl).toMatch(/if\s*\(/);
    expect(glsl).not.toContain('OUTPUT.w');
  });

  it('保留卷积权重常量（不能被转换破坏）', () => {
    const { passes } = parseMpvShader(SAMPLE);
    const glsl = passToWebGL(passes[0], ['MAIN']);
    expect(glsl).toContain('mat4');
    expect(glsl).toContain('0.5');
  });
});
