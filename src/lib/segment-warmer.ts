import {
  buildSegmentCacheKey,
  hasCachedSegment,
  putCachedSegmentResilient,
  type CacheSettings,
} from './video-cache';

/**
 * 分片预热（下载 + 落盘）公共层。
 *
 * 为什么需要这一层：起播压、seek 预取、前向预取三条链路都会下载同一个分片。
 * 没有统一入口时，同一个分片会被并发下载多次——白耗带宽，还可能把正在播的分片挤掉。
 * 这里用「在途登记表」把同 key 的并发请求合并成一次：
 *   - 先到的负责下载，后到的直接复用它的 Promise；
 *   - 已经缓存过的直接跳过（cache-first，与 loader 侧同一套 key 规则）。
 *
 * 并发控制：所有链路共用一个全局闸门，避免多条链路叠加把带宽吃满。
 */

export type SegmentWarmStatus = 'cached' | 'ok' | 'quota' | 'failed';

export interface SegmentWarmOutcome {
  status: SegmentWarmStatus;
  bytes: number;
}

export interface WarmSegmentOptions {
  episodeKey: string;
  /** 分片序号（1 基），写进 LRU 元数据便于排查 */
  index: number;
  settings: CacheSettings;
  signal?: AbortSignal;
  /** 归属者标识：中止时按 owner 精确清理自己的在途记录 */
  owner: string;
}

export interface WarmBatchOptions {
  episodeKey: string;
  settings: CacheSettings;
  signal?: AbortSignal;
  owner: string;
  /** 本批次的并发上限 */
  concurrency?: number;
  /**
   * 软停止条件：返回 false 时不再领取新的分片（已在下载的那个会跑完并落盘）。
   * 用于「拖动落点变了」——正在下的那一片正是最需要的，不能半途取消。
   */
  shouldContinue?: () => boolean;
}

export interface WarmSegmentItem {
  url: string;
  index: number;
}

export interface WarmBatchResult {
  warmed: number;
  cached: number;
  failed: number;
}

interface InFlightEntry {
  promise: Promise<SegmentWarmOutcome>;
  owner: string;
}

const inflight = new Map<string, InFlightEntry>();

/** 查询某分片是否正在被预热（loader 侧据此避免重复下载） */
export function peekInFlightSegment(key: string): Promise<SegmentWarmOutcome> | undefined {
  return inflight.get(key)?.promise;
}

/** 清理在途登记（owner 缺省 = 全清；主要用于中止与测试） */
export function clearSegmentFetchRegistry(owner?: string): void {
  if (!owner) {
    inflight.clear();
    return;
  }
  for (const [key, entry] of inflight) {
    if (entry.owner === owner) inflight.delete(key);
  }
}

// —— 全局并发闸门 ——
// 前向预取、seek 预取、起播压共用：总并发上限由设置里的「预取并发数」决定，
// 再额外留 1 个槽位给交互型预取（seek/起播），避免被前向预取饿死。
const HARD_MAX_CONCURRENCY = 8;
let fetchLimit = 4;
let activeFetches = 0;
const slotWaiters: Array<() => void> = [];

export function setFetchLimit(limit: number): void {
  fetchLimit = Math.min(HARD_MAX_CONCURRENCY, Math.max(1, Math.round(limit)));
}

function acquireSlot(): Promise<void> {
  if (activeFetches < fetchLimit) {
    activeFetches += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    slotWaiters.push(resolve);
  });
}

function releaseSlot(): void {
  activeFetches = Math.max(0, activeFetches - 1);
  const next = slotWaiters.shift();
  if (next) {
    activeFetches += 1;
    next();
  }
}

async function downloadAndStore(
  key: string,
  url: string,
  opts: WarmSegmentOptions
): Promise<SegmentWarmOutcome> {
  await acquireSlot();
  const started = performance.now();
  try {
    const res = await fetch(url, { signal: opts.signal, headers: { Accept: '*/*' } });
    if (!res.ok) return { status: 'failed', bytes: 0 };
    const buffer = await res.arrayBuffer();
    const costMs = performance.now() - started;
    const result = await putCachedSegmentResilient(key, buffer, {
      episodeKey: opts.episodeKey,
      index: opts.index,
      costMs,
      settings: opts.settings,
    });
    if (result === 'ok') return { status: 'ok', bytes: buffer.byteLength };
    return { status: result === 'quota' ? 'quota' : 'failed', bytes: 0 };
  } catch {
    // 单分片失败不中断整批（网络抖动/源限流），播放侧有自己的重试
    return { status: 'failed', bytes: 0 };
  } finally {
    releaseSlot();
  }
}

/**
 * 预热单个分片：已缓存则跳过；已有同 key 在途请求则复用它的结果。
 * 返回的 Promise 一定 resolve（不 reject），调用方无需处理异常。
 */
export function warmSegment(url: string, opts: WarmSegmentOptions): Promise<SegmentWarmOutcome> {
  const key = buildSegmentCacheKey(url);
  const existing = inflight.get(key);
  if (existing) return existing.promise;

  const entry: InFlightEntry = {
    promise: undefined as unknown as Promise<SegmentWarmOutcome>,
    owner: opts.owner,
  };
  const promise = (async () => {
    if (await hasCachedSegment(key)) return { status: 'cached' as const, bytes: 0 };
    return downloadAndStore(key, url, opts);
  })().finally(() => {
    if (inflight.get(key) === entry) inflight.delete(key);
  });
  entry.promise = promise;
  inflight.set(key, entry);
  return promise;
}

/**
 * 批量预热：按入参顺序下载（顺序即优先级：目标分片排最前），
 * 并发由批次上限与全局闸门共同约束。
 */
export async function warmSegments(
  items: WarmSegmentItem[],
  opts: WarmBatchOptions
): Promise<WarmBatchResult> {
  const result: WarmBatchResult = { warmed: 0, cached: 0, failed: 0 };
  if (!items.length) return result;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      if (opts.signal?.aborted) return;
      if (opts.shouldContinue && !opts.shouldContinue()) return;
      const item = items[cursor++];
      if (!item) return;
      const outcome = await warmSegment(item.url, {
        episodeKey: opts.episodeKey,
        index: item.index,
        settings: opts.settings,
        signal: opts.signal,
        owner: opts.owner,
      });
      if (outcome.status === 'ok') result.warmed += 1;
      else if (outcome.status === 'cached') result.cached += 1;
      else result.failed += 1;
      if (outcome.status === 'quota') return;
    }
  };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, HARD_MAX_CONCURRENCY));
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}
