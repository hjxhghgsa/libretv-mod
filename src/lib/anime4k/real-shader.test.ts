import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMpvShader, passToWebGL, collectBinds } from './mpv-to-webgl';

const FILES = [
  'Anime4K_Restore_CNN_M.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl',
  'Anime4K_Restore_CNN_VL.glsl',
  'Anime4K_Upscale_CNN_x2_VL.glsl',
  'Anime4K_Clamp_Highlights.glsl',
];

describe('真实着色器 → WebGL 转换', () => {
  for (const f of FILES) {
    it(`${f} 生成的 GLSL 合法`, () => {
      const src = readFileSync(`public/shaders/anime4k/${f}`, 'utf-8');
      const { passes } = parseMpvShader(src);
      const globalBinds = [...collectBinds(passes), 'MAIN', 'HOOKED'];
      const problems: string[] = [];

      passes.forEach((p, i) => {
        const frag = passToWebGL(p, globalBinds);

        // ① 不该再有「函数调用 + 非数字下标」
        const re = /\)\s*\[\s*([^\]\[]+?)\s*\]/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(frag)) !== null) {
          if (!/^\d+$/.test(mm[1].trim())) {
            problems.push(`pass#${i} 动态下标: ${mm[0].slice(0, 90)}`);
          }
        }

        // ② 括号必须平衡（改写时最容易出错的地方）
        let depth = 0;
        let line = 1;
        for (const ch of frag) {
          if (ch === '\n') line++;
          else if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth < 0) { problems.push(`pass#${i} 括号提前闭合 @L${line}`); break; }
          }
        }
        if (depth !== 0) problems.push(`pass#${i} 括号不平衡: 剩余 ${depth}`);

        // ③ swizzle4 的参数个数必须是 2
        // swizzle4(...) 的完整调用（括号平衡）
        let si = 0;
        while ((si = frag.indexOf('swizzle4(', si)) >= 0) {
          const open = si + 'swizzle4'.length;
          let d = 0, k = open, commas = 0;
          for (; k < frag.length; k++) {
            const ch = frag[k];
            if (ch === '(') d++;
            else if (ch === ')') { d--; if (d === 0) break; }
            else if (ch === ',' && d === 1) commas++;
          }
          if (k >= frag.length) { problems.push(`pass#${i} swizzle4 未闭合`); break; }
          if (commas !== 1) {
            problems.push(`pass#${i} swizzle4 参数数异常(${commas + 1}): ${frag.slice(si, k + 1).slice(0, 120)}`);
          }
          si = k + 1;
        }
      });

      if (problems.length) console.log(`[${f}] 问题:\n` + problems.slice(0, 6).join('\n'));
      expect(problems).toEqual([]);
    });
  }
});
