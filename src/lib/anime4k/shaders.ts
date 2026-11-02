/**
 * Anime4K 着色器资源加载
 *
 * Anime4K 的 mpv GLSL 来自 Kazumi 自带的规则包（MIT 许可，Anime4K 作者 bloc97）。
 * 放到 public/shaders/anime4k/ 下由前端 fetch 加载 —— 走静态资源不走服务端 API，
 * 避免把 300KB 的着色器塞进每个 API 响应。
 *
 * ★ 为什么不用 import 把 GLSL 塞进 bundle：
 *   那样会把文本塞进 JS chunk，浏览器每次都要解压解析；
 *   放成独立 .glsl 文件还能被浏览器缓存，切换画质档时只拉需要的那几个。
 */

export const ANIME4K_SHADER_FILES = [
  'Anime4K_Restore_CNN_M.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl',
  'Anime4K_Restore_CNN_VL.glsl',
  'Anime4K_Upscale_CNN_x2_VL.glsl',
  'Anime4K_Clamp_Highlights.glsl',
] as const;

export type Anime4KShaderFile = (typeof ANIME4K_SHADER_FILES)[number];

const BASE = '/shaders/anime4k';

/** 拉取全部着色器源码；失败的记为空串，由引擎在编译时报错 */
export async function loadAnime4KShaders(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    ANIME4K_SHADER_FILES.map(async (name) => {
      try {
        const res = await fetch(`${BASE}/${name}`, { cache: 'force-cache' });
        if (!res.ok) return [name, ''] as const;
        return [name, await res.text()] as const;
      } catch {
        return [name, ''] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}
