/**
 * 按地址后缀推断播放器类型。
 *
 * 为什么需要：ArtPlayer 的 `type` 硬编码 'm3u8' 时，用户贴 mp4/webm 直链
 * 会被塞给 hls.js 当 HLS 解析 —— 拿不到 manifest，表现就是永远转圈。
 * 采集站绝大多数给 m3u8，但「手动添加直链源」和「分享单个 mp4」都很常见。
 *
 * 判定只看后缀（查询串之前那段），因为直链常带 `?sign=xxx&t=xxx`。
 */

/** 明确的 HLS 标志：后缀 .m3u8/.m3u，或路径里出现 /m3u8/（采集站常见伪静态形式） */
const M3U8_RE = /\.m3u8?(\?|#|$)/i;
/** 已知可直接播的渐进式格式 */
const NATIVE_RE = /\.(mp4|m4v|webm|mov|mkv)(\?|#|$)/i;

export function inferMediaType(url: string): 'm3u8' | 'mp4' {
  try {
    const path = new URL(url, 'http://x.invalid').pathname;
    if (M3U8_RE.test(path) || path.includes('/m3u8/')) return 'm3u8';
    if (NATIVE_RE.test(path)) return 'mp4';
  } catch {
    // 地址解析不了时按 m3u8 走：采集站默认形态，且有代理兜底
  }
  return 'm3u8';
}
