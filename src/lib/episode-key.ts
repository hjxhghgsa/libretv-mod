/**
 * 剧集键（episodeKey）派生。
 *
 * 为什么需要它：
 *   episodeKey 是「片段缓存按集淘汰」的分组键，也是「m3u8 解析结果缓存」的键的一部分。
 *   直链播放（分享链接、自建直连源）没有「源:影片:集数」的上下文，
 *   没有 episodeKey 就等于整条加速链路全关（缓存不写、预取不跑）——
 *   而直链恰恰是最需要加速的场景（没有集数上下文，源站往往更慢）。
 *
 * 派生规则（必须同时满足三条）：
 *   ① 稳定：同一地址每次派生结果一致，否则缓存永远命中不了；
 *   ② 不与搜索结果路径冲突：搜索结果是 `${source}:${vodId}:${episodeIndex}`，
 *      派生键统一带 `direct:` 前缀；
 *   ③ 不因短时效签名参数而变化：`?sign=xxx&t=xxx` 这类每次都变的参数
 *      必须在派生前剥掉，否则派生键每次都不同 → 缓存恒不命中。
 */

/** 派生键前缀：与搜索结果路径的 `${source}:${vodId}:${index}` 不会撞车 */
export const DIRECT_EPISODE_KEY_PREFIX = 'direct:';

/**
 * 短时效参数名（小写比较）。
 * 这些参数的内容会随「每一次请求」变化（签名/令牌/时间戳），
 * 留着它们派生键就跟着变 → 缓存永远命中不了。
 */
const VOLATILE_PARAM_NAMES = new Set([
  'sign', 'signature', 'sig', 'token', 'auth', 'authorization', 'secret',
  't', 'ts', 'time', 'timestamp', 'exp', 'expires', 'expiry', 'nonce',
  'rand', 'random', 'rnd', 'session', 'sessionid', 'sid', 'jwt',
  'hdnts', 'wstime', 'wssecret', 'wssip', 'wshost', 'policy',
  'cachebust', 'cb', '_t', '_ts', 'x', 'x-t',
]);

/** 归一化用的固定基址：相对地址（代理形态）也能解析成确定的绝对形式 */
const NORMALIZE_BASE = 'http://libretv.local/';

/**
 * 纯函数：判断某个查询参数是否属于「每次请求都会变」的短时效参数。
 *
 * 除了已知的参数名，还兜住两类：
 *   - 云厂商签名参数（x-amz-signature / x-oss-date 之类，名字里带 sign/time/date）；
 *   - 值是 10~13 位纯数字（unix 秒/毫秒时间戳），哪怕参数名不认识也会变。
 */
export function isVolatileParam(name: string, value: string): boolean {
  const lower = name.trim().toLowerCase();
  if (VOLATILE_PARAM_NAMES.has(lower)) return true;
  if (lower.startsWith('x-') && /sign|token|time|date|cred|policy/.test(lower)) return true;
  if (/^\d{10,13}$/.test(value.trim())) return true;
  return false;
}

/**
 * 纯函数：剥掉短时效参数后的规范化地址。
 *
 * 额外处理两件事：
 *   - 代理形态（/api/proxy?url=<编码后的真实地址>）的内层 url 参数递归同样处理，
 *     否则内层的签名照样会让派生键每次都变；
 *   - 去掉 fragment（不参与 HTTP 请求，与资源身份无关）。
 */
export function stripVolatileParams(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed, NORMALIZE_BASE);
  } catch {
    return trimmed;
  }
  const entries = [...parsed.searchParams.entries()];
  parsed.search = '';
  parsed.hash = '';
  for (const [name, value] of entries) {
    if (isVolatileParam(name, value)) continue;
    // 代理形态：内层 url 参数里的签名也要剥
    let next = value;
    if (name.toLowerCase() === 'url' && /^https?:\/\//i.test(value)) {
      next = stripVolatileParams(value);
    }
    parsed.searchParams.append(name, next);
  }
  return parsed.toString();
}

/**
 * 纯函数：字符串哈希（FNV-1a + djb2 双哈希拼一起 → 16 位十六进制）。
 * 不引三方库；两个不同算法拼接是为了把碰撞概率压到可忽略。
 */
export function hashString(input: string): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
    djb = ((djb << 5) + djb + code) >>> 0;
  }
  return fnv.toString(16).padStart(8, '0') + djb.toString(16).padStart(8, '0');
}

/**
 * 纯函数：由播放地址派生一个稳定的剧集键。
 * 地址为空 → 返回空串（表示「没有可用剧集键」，调用方据此关闭加速）。
 */
export function deriveEpisodeKeyFromUrl(url: string): string {
  const normalized = stripVolatileParams(url);
  if (!normalized) return '';
  return `${DIRECT_EPISODE_KEY_PREFIX}${hashString(normalized)}`;
}

/**
 * 纯函数：确定最终使用的剧集键。
 *   - 调用方显式给了（搜索结果路径 / ?ep=）→ 用它；
 *   - 没给 → 按播放地址派生（直链播放场景，零配置自动走加速）；
 *   - 连地址都没有 → 空串（调用方据此关闭加速）。
 */
export function resolveEpisodeKey(explicit: string | undefined | null, url: string): string {
  const trimmed = (explicit ?? '').trim();
  if (trimmed) return trimmed;
  return deriveEpisodeKeyFromUrl(url);
}
