/**
 * HLS 中继：把「按需下发」的源改造成「一次给全」。
 *
 * ## 要解决的问题
 * 很多采集站用动态切片源：m3u8 **不写 `#EXT-X-ENDLIST`**，服务端一次只返回
 * 当前已生成的那几个分片（常见是 30 秒），播完一个才在下次刷新 playlist 时多给一个。
 * 客户端（hls.js / mpv）只能看到已下发的那部分，于是：
 *   · 进度条总时长显示 30 秒，**边看边慢慢涨**；
 *   · 想拖动到后面 —— 清单里根本没有那些分片，无从 seek；
 *   · 预取也无从预起 —— 源不给。
 *
 * ## 思路
 * 播放本来就经过我们的服务端代理（`/api/proxy?url=…`），那就让**服务端主动**干活：
 *   ① 周期性地去源站拉 m3u8，把历次拿到的分片**按出现序合并去重**成一份累积清单；
 *   ② 客户端请求 m3u8 时，直接返回这份**合并清单** —— 一次性看到全部分片，
 *      总时长立刻正确，任意位置都能 seek；
 *   ③ 合并清单里新出现的分片，由服务端**异步预拉**进内存缓存；
 *      客户端请求分片时命中缓存 → 零网络往返。
 *
 * 静态源（带 `#EXT-X-ENDLIST`）合并结果等于原样，且检测到 ENDLIST 就停止刷新，不浪费。
 *
 * ## 生命周期
 *   · 首次有客户端请求该 m3u8 → 建中继 + 立即刷新一次；
 *   · 之后每 REFRESH_INTERVAL_MS 刷新，直到源站给出 ENDLIST；
 *   · IDLE_TIMEOUT_MS 无客户端访问 → 停表并释放（避免常驻进程里无限占资源）。
 */

/** 中继刷新间隔：动态源的分片追加通常以秒计，1.5s 足够跟上且不算激进 */
const REFRESH_INTERVAL_MS = 1500;
/** 空闲多久没人请求就停表释放 */
const IDLE_TIMEOUT_MS = 30_000;
/** 单个中继最多预拉缓存的分片数 */
const MAX_CACHED_SEGMENTS_PER_RELAY = 200;
/** 全部中继合计的分片缓存字节上限（LRU 逐出） */
const MAX_TOTAL_CACHE_BYTES = 512 * 1024 * 1024;
/** 预拉并发：太高会把源站打满，也可能和播放请求抢带宽 */
const PREFETCH_CONCURRENCY = 4;

export interface RelaySegment {
  /** 源站绝对地址（未代理化） */
  url: string;
  /** EXTINF 时长（秒）；缺失按 0 计 */
  duration: number;
}

interface RelayEntry {
  /** 代理请求里的原始目标地址（key） */
  key: string;
  /** 源站重定向后的最终地址（解析相对分片用） */
  baseUrl: string;
  /** 累积分片：按出现序，URL 去重 */
  segments: RelaySegment[];
  seen: Set<string>;
  /** 源站已给出 ENDLIST（静态源）→ 不再周期刷新 */
  complete: boolean;
  /** 是否 master playlist（含 #EXT-X-STREAM-INF）—— 那种不做合并，直接透传 */
  isMaster: boolean;
  lastAccess: number;
  timer: ReturnType<typeof setInterval> | null;
  /** 分片预拉缓存：源站绝对地址 → 字节 */
  cache: Map<string, { buf: Buffer; at: number }>;
  cacheBytes: number;
  /** 正在预拉的分片（避免重复请求同一个） */
  inflight: Set<string>;
}

/** 全部中继表（供反查：分片地址 → 所属中继）。测试用 resetRelays 清空 */
export const relays = new Map<string, RelayEntry>();
let totalCacheBytes = 0;

/** 供测试/诊断：当前中继数量与缓存占用 */
export function relayStats() {
  return {
    relays: relays.size,
    cachedSegments: Array.from(relays.values()).reduce((n, r) => n + r.cache.size, 0),
    cacheBytes: totalCacheBytes,
  };
}

function touch(entry: RelayEntry): void {
  entry.lastAccess = Date.now();
}

function createEntry(key: string, baseUrl: string): RelayEntry {
  const entry: RelayEntry = {
    key,
    baseUrl,
    segments: [],
    seen: new Set(),
    complete: false,
    isMaster: false,
    lastAccess: Date.now(),
    timer: null,
    cache: new Map(),
    cacheBytes: 0,
    inflight: new Set(),
  };
  relays.set(key, entry);
  return entry;
}

export function getRelay(key: string): RelayEntry | undefined {
  return relays.get(key);
}

/**
 * 取得（或创建）中继，并确保刷新表在跑。
 * 调用方（代理的 m3u8 分支）每次请求都会走到这里。
 */
export function getOrCreateRelay(key: string, baseUrl: string): RelayEntry {
  const existing = relays.get(key);
  if (existing) {
    existing.baseUrl = baseUrl;
    touch(existing);
    return existing;
  }
  const entry = createEntry(key, baseUrl);
  entry.timer = setInterval(() => {
    void refreshRelay(entry);
    sweepIfIdle(entry);
  }, REFRESH_INTERVAL_MS);
  return entry;
}

function sweepIfIdle(entry: RelayEntry): void {
  if (Date.now() - entry.lastAccess < IDLE_TIMEOUT_MS) return;
  releaseRelay(entry);
}

/** 停表并释放一个中继（含它的分片缓存） */
function releaseRelay(entry: RelayEntry): void {
  if (entry.timer) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
  for (const url of entry.cache.keys()) {
    totalCacheBytes -= entry.cache.get(url)?.buf.byteLength ?? 0;
  }
  entry.cache.clear();
  entry.inflight.clear();
  relays.delete(entry.key);
}

/** 解析 m3u8 文本，取出「分片地址 + EXTINF 时长」的有序列表 */
export function parseSegments(text: string, baseUrl: string): {
  segments: RelaySegment[];
  isMaster: boolean;
  complete: boolean;
} {
  const lines = text.split(/\r?\n/);
  const segments: RelaySegment[] = [];
  let isMaster = false;
  let complete = false;
  let pendingDuration: number | null = null;
  let pendingRange: { n: number; offset: number } | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) { isMaster = true; continue; }
    if (line === '#EXT-X-ENDLIST') { complete = true; continue; }
    if (line.startsWith('#EXTINF:')) {
      const v = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
      pendingDuration = Number.isFinite(v) ? v : 0;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const m = line.slice('#EXT-X-BYTERANGE:'.length).match(/^(\d+)(?:@(\d+))?/);
      if (m) {
        pendingRange = { n: Number(m[1]), offset: m[2] ? Number(m[2]) : 0 };
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // 普通行 = 分片 URI
    // ★ master playlist 的 URI 行是「变体引用」不是分片，一律不收
    if (isMaster) continue;
    let abs: string;
    try {
      abs = new URL(line, baseUrl).href;
    } catch {
      continue;
    }
    if (pendingRange) {
      // byterange 分片：同一 URL 会被引用多次，用 offset 区分
      abs = `${abs}#byte=${pendingRange.offset}-${pendingRange.offset + pendingRange.n - 1}`;
      pendingRange = null;
    }
    segments.push({ url: abs, duration: pendingDuration ?? 0 });
    pendingDuration = null;
  }

  return { segments, isMaster, complete };
}

/**
 * 拉一次源站 m3u8，把新分片合并进累积清单。
 * 失败静默（网络抖动不该让播放挂掉），保留旧数据。
 */
export async function refreshRelay(entry: RelayEntry): Promise<void> {
  try {
    const res = await fetch(entry.baseUrl, {
      headers: { Accept: 'application/vnd.apple.mpegurl, */*' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const text = await res.text();
    if (!text.includes('#EXTM3U')) return;

    const { segments, isMaster, complete } = parseSegments(text, entry.baseUrl);
    if (isMaster) {
      // master playlist：交给原有 rewrite 逻辑透传，中继不掺和
      entry.isMaster = true;
      entry.complete = true;
      return;
    }
    if (!segments.length) return;

    let added = 0;
    for (const seg of segments) {
      if (entry.seen.has(seg.url)) continue;
      entry.seen.add(seg.url);
      entry.segments.push(seg);
      added++;
    }
    if (complete) {
      entry.complete = true;
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    }
    // 有新分片就预拉（起播时首批最重要）
    if (added > 0) void prefetchNewSegments(entry);
  } catch {
    /* 单次刷新失败保留旧数据，下一轮再试 */
  }
}

/** 把累积分片写成一份 m3u8：分片地址经 rewriteM3u8 统一走代理 */
export function buildMergedPlaylist(entry: RelayEntry, prefix: string): string {
  const head = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:' +
      Math.max(1, Math.ceil(Math.max(0, ...entry.segments.map((s) => s.duration)))),
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  const body = entry.segments.map((s) => {
    // 分片地址交给 rewriteM3u8 处理（相对/绝对都锚成代理形式）
    return `#EXTINF:${s.duration.toFixed(3)},\n${rewriteUri(s.url, entry.baseUrl, prefix)}`;
  });
  // 故意不写 ENDLIST：源是动态的，客户端还要继续刷新；
  // 但内容已是「全部分片」，总时长与 seek 能力都正确了。
  return `${head.join('\n')}\n${body.join('\n')}\n`;
}

/** 单个分片 URI 的代理化（复用 m3u8.ts 里的同一套规则，保证与播放器侧一致） */
function rewriteUri(uri: string, baseUrl: string, prefix: string): string {
  // rewriteM3u8 只处理带 # 的标签行，普通 URI 行原样返回；
  // 所以这里自己锚绝对地址 + 加前缀，规则与 rewriteM3u8 内部保持一致。
  let abs = uri;
  try {
    abs = new URL(uri, baseUrl).href;
  } catch {
    /* 相对地址锚不动时原样用 */
  }
  return prefix + encodeURIComponent(abs);
}

// ── 分片预拉缓存 ────────────────────────────────────────────────

function cacheGet(entry: RelayEntry, url: string): Buffer | undefined {
  const hit = entry.cache.get(url);
  if (!hit) return undefined;
  // LRU：命中就搬到队尾
  entry.cache.delete(url);
  entry.cache.set(url, hit);
  return hit.buf;
}

function cachePut(entry: RelayEntry, url: string, buf: Buffer): void {
  const prev = entry.cache.get(url);
  if (prev) {
    entry.cacheBytes -= prev.buf.byteLength;
    totalCacheBytes -= prev.buf.byteLength;
    entry.cache.delete(url);
  }
  entry.cache.set(url, { buf, at: Date.now() });
  entry.cacheBytes += buf.byteLength;
  totalCacheBytes += buf.byteLength;

  // 单中继上限：逐最旧
  while (entry.cache.size > MAX_CACHED_SEGMENTS_PER_RELAY) {
    const oldest = entry.cache.keys().next();
    if (oldest.done) break;
    const k = oldest.value;
    const v = entry.cache.get(k);
    if (v) {
      entry.cacheBytes -= v.buf.byteLength;
      totalCacheBytes -= v.buf.byteLength;
    }
    entry.cache.delete(k);
  }
  // 全局上限：跨中继逐最旧
  while (totalCacheBytes > MAX_TOTAL_CACHE_BYTES) {
    let victim: RelayEntry | null = null;
    let victimKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const r of relays.values()) {
      for (const [k, v] of r.cache) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          victim = r;
          victimKey = k;
        }
      }
    }
    if (!victim || !victimKey) break;
    const v = victim.cache.get(victimKey);
    if (v) {
      victim.cacheBytes -= v.buf.byteLength;
      totalCacheBytes -= v.buf.byteLength;
    }
    victim.cache.delete(victimKey);
  }
}

/** 查分片缓存（代理的分片分支先走这里） */
export function readSegmentCache(key: string, url: string): Buffer | undefined {
  const entry = relays.get(key);
  if (!entry) return undefined;
  touch(entry);
  return cacheGet(entry, url);
}

/** 分片透传成功后顺手入缓存，供后续请求命中 */
export function writeSegmentCache(key: string, url: string, buf: Buffer): void {
  const entry = relays.get(key);
  if (!entry) return;
  cachePut(entry, url, buf);
}

/** 预拉合并清单里尚未缓存的分片（限量 + 并发，避免打满源站） */
async function prefetchNewSegments(entry: RelayEntry): Promise<void> {
  const pending = entry.segments.filter(
    (s) => !entry.cache.has(s.url) && !entry.inflight.has(s.url)
  );
  if (!pending.length) return;
  // 只预热最前面的若干片：起播/seek 近距离命中率最高
  const batch = pending.slice(0, PREFETCH_CONCURRENCY * 4);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < batch.length) {
      const seg = batch[idx++];
      if (entry.cache.has(seg.url) || entry.inflight.has(seg.url)) continue;
      entry.inflight.add(seg.url);
      try {
        const res = await fetch(seg.url, {
          signal: AbortSignal.timeout(10_000),
          headers: { Accept: '*/*' },
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          cachePut(entry, seg.url, buf);
        }
      } catch {
        /* 单片失败跳过 */
      } finally {
        entry.inflight.delete(seg.url);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PREFETCH_CONCURRENCY, batch.length) }, worker)
  );
}

/** 供测试：清空所有中继 */
export function resetRelays(): void {
  for (const entry of Array.from(relays.values())) releaseRelay(entry);
  relays.clear();
  totalCacheBytes = 0;
}
