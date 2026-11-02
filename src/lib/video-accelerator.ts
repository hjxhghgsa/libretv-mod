import {
  buildPlaylistCacheKey,
  cacheMediaPlaylist,
  fromCachedMedia,
  getPlaylistWithCache,
  isPlaylistCacheFresh,
  readPlaylistEntry,
} from './m3u8-cache';
import { parseCapturedPlaylist, type ParsedPlaylist } from './m3u8-parse';
import { computeWindow, indexAtTime, shouldPrefetch } from './video-prefetcher';
import { resolveEpisodeKey } from './episode-key';
import { ensurePersistentStorage, loadCacheSettings } from './video-cache';
import {
  clearSegmentFetchRegistry,
  setFetchLimit,
  warmSegments,
  type WarmSegmentItem,
} from './segment-warmer';

/**
 * 播放加速器：把「秒开」和「拖动不卡顿」两件事落到具体动作上。
 *
 * 三个能力：
 *   ① 起播压（缺口②）：起播阶段并行推进——清单解析、首批分片预热、提前建连；
 *   ② seek 预取（缺口①）：拖动过程中就把目标位置附近的分片拉下来，
 *      等 hls.js 真正请求时缓存已命中，拖动不再等网络；
 *   ③ 清单复用（缺口③）：清单文本由 hls.js loader 捕获复用，解析结果进缓存，
 *      换集/重播不必再走一次「拉清单 → 解析」。
 *
 * ★ 分片地址必须与播放器完全一致，否则缓存永远不命中：
 *   加速器用的是 hls.js 当前档位的 media 清单（loader 捕获），
 *   分片地址由同一份文本、同一套 base 解析而来，key 与 loader 侧收敛。
 */

/** seek 目标点回看时长（秒）：覆盖拖动落点附近的缓冲 */
export const SEEK_LOOK_BEHIND_SECONDS = 15;
/** seek 目标点前瞻时长（秒）：拖过去之后要连续播下去的那一段 */
export const SEEK_LOOK_AHEAD_SECONDS = 120;
/** seek 预取的节流间隔（毫秒）：拖动过程中位置一直在变，最多每这么久启一轮 */
export const SEEK_THROTTLE_MS = 80;
/** timeupdate 里判定「大幅跳变」的阈值（秒）：普通播放每拍只有 0.25s 左右 */
export const SEEK_TRIGGER_JUMP_SECONDS = 8;
/** 起播阶段预热的首批分片数 */
export const STARTUP_WARM_SEGMENTS = 6;
/** seek 预取的并发上限（比前向预取低，交互优先但不能抢带宽） */
export const SEEK_WARM_CONCURRENCY = 3;
/** 等待 loader 捕获清单的上限（毫秒）：hls.js 正在拉的那份清单，等它即可 */
const CAPTURE_WAIT_MS = 2000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 预取被关闭时的占位清单：没有分片 → 调用方自然不会下载任何东西 */
const EMPTY_PLAYLIST: ParsedPlaylist = {
  segments: [],
  byterange: false,
  totalDuration: 0,
  mediaSequence: 0,
};

/**
 * 纯函数：窗口内的下载顺序。
 * 目标分片排第一（拖过去后第一帧就靠它），然后向前铺，最后回看。
 *
 * 窗口本身用 video-prefetcher.computeWindow 求（seek 落点 = 窗口锚点，
 * horizon = 前瞻秒数、lookBehind = 回看秒数），这里只负责「先下哪一片」。
 */
export function buildSeekOrder(fromIdx: number, toIdx: number, targetIdx: number): number[] {
  if (toIdx <= fromIdx) return [];
  const target = clamp(targetIdx, fromIdx, toIdx - 1);
  const order: number[] = [target];
  for (let i = target + 1; i < toIdx; i++) order.push(i);
  for (let i = target - 1; i >= fromIdx; i--) order.push(i);
  return order;
}

/** 纯函数：timeupdate 里判断这一拍是否发生了大幅跳变（拖动/恢复进度/跳过片段） */
export function isSignificantJump(
  delta: number,
  threshold: number = SEEK_TRIGGER_JUMP_SECONDS
): boolean {
  if (!Number.isFinite(delta)) return false;
  return Math.abs(delta) >= threshold;
}

/**
 * 纯函数：下一次 seek 预取的启动延迟。
 * 首次（还没跑过）立即开跑——拖动过程中不等用户松手，
 * 否则落点分片总是「松手后才开始下载」，拖动照样卡。
 */
export function computeSeekStartDelay(
  lastRunAt: number,
  now: number,
  throttleMs: number = SEEK_THROTTLE_MS
): number {
  if (!lastRunAt) return 0;
  return Math.max(0, throttleMs - (now - lastRunAt));
}

export interface AcceleratorEpisode {
  /** 本集清单地址（直连或代理改写形式，与播放器一致） */
  m3u8Url: string;
  /**
   * 剧集标识 `${source}:${vodId}:${episodeIndex}`。
   * 缺省时按清单地址派生一个稳定键（直链播放没有集数上下文）——
   * 没有它就等于整条加速链路全关，而直链恰恰最需要加速。
   */
  episodeKey?: string;
}

export interface AcceleratorOptions {
  /** 是否剔除广告段：必须与播放器的广告过滤开关一致，否则分片地址对不上 */
  stripLeadAd?: boolean;
  /** hls.js 当前档位码率（按码率选变体，保证预取与播放同档） */
  preferredBitrate?: number;
}

/** 提前建立连接：向浏览器预连清单所在源站 */
const preconnectedOrigins = new Set<string>();
function preconnectOrigin(url: string): void {
  if (typeof document === 'undefined') return;
  try {
    const origin = new URL(url, document.baseURI).origin;
    if (!origin || origin === 'null' || preconnectedOrigins.has(origin)) return;
    preconnectedOrigins.add(origin);
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  } catch {
    /* 忽略：预连只是加速手段，失败不影响播放 */
  }
}

/** 等待清单到达的回调：check = 清单到了；cancel = 换集/卸载，提前收摊 */
interface CaptureWaiter {
  check: () => void;
  cancel: () => void;
}

/** 加速器内部持有的剧集信息（episodeKey 已解析，必定非空） */
interface ActiveEpisode {
  m3u8Url: string;
  episodeKey: string;
}

/**
 * 播放加速器（每集一个状态，跨集由 startEpisode 重置）。
 */
export class VideoAccelerator {
  private episode?: ActiveEpisode;
  private stripLeadAd = true;
  private preferredBitrate?: number;
  /** hls.js 当前档位的 media 清单地址 */
  private levelUrl?: string;
  /** loader 捕获到的清单文本：url → 文本 */
  private captured = new Map<string, string>();
/** 等待清单到达的回调 */
private captureWaiters: CaptureWaiter[] = [];
  private playlist?: ParsedPlaylist;
  private playlistPromise?: Promise<ParsedPlaylist>;
  private seekTimer?: ReturnType<typeof setTimeout>;
  private seekTarget?: number;
  private seekRunAt = 0;
  /** 轮次号：落点变了就换一轮，旧轮次软停止（已在下完的那一片不浪费） */
  private seekGeneration = 0;
  private seekAbort?: AbortController;
  private startupAbort?: AbortController;
  private readonly owner = 'accelerator';
  private stopped = false;

  /** 换集：重置全部状态并触发起播压 */
  startEpisode(episode: AcceleratorEpisode, options: AcceleratorOptions = {}): void {
    this.reset();
    const episodeKey = resolveEpisodeKey(episode.episodeKey, episode.m3u8Url);
    if (!episodeKey) return;
    this.episode = { m3u8Url: episode.m3u8Url, episodeKey };
    this.stripLeadAd = options.stripLeadAd ?? true;
    this.preferredBitrate = options.preferredBitrate;
    this.stopped = false;
    // 本集的硬中止信号：换集/卸载时一次性掐断所有预热
    this.seekAbort = new AbortController();

    const settings = loadCacheSettings();
    // 全局闸门：前向预取留 maxConcurrency 个槽，额外 1 个给交互型预取
    setFetchLimit(settings.maxConcurrency + 1);
    void ensurePersistentStorage();
    preconnectOrigin(episode.m3u8Url);
    void this.warmFromCache();
  }

  /** 播放链路是否就是当前剧集：换集后旧链路的迟到响应据此被丢弃 */
  isCurrentEpisode(m3u8Url: string): boolean {
    return !!this.episode && this.episode.m3u8Url === m3u8Url;
  }

  /**
   * hls.js 切换档位：分片地址全变，重新解析并预热当前位置附近。
   * bitrate 用来在「拿不到清单捕获」时按码率对齐变体（与 hls.js 选中的档位一致）。
   */
  setCurrentLevelUrl(url: string, currentTime: number, bitrate?: number): void {
    if (!this.episode || !url) return;
    if (typeof bitrate === 'number' && bitrate > 0) this.preferredBitrate = bitrate;
    if (this.levelUrl === url) return;
    this.levelUrl = url;
    this.playlist = undefined;
    this.playlistPromise = undefined;
    // 省流量 / 2G 下只记录档位，不解析清单、更不预热
    if (!this.prefetchAllowed()) return;
    const raw = this.captured.get(url);
    if (raw) {
      void this.adoptCaptured(url, raw).then(() => this.warmAround(currentTime));
      return;
    }
    void this.getPlaylist()
      .then(() => this.warmAround(currentTime))
      .catch(() => undefined);
  }

  /**
   * 接收 hls.js loader 捕获到的清单文本。
   * media 清单解析后立即采用（这就是「起播压」的触发点：清单到手即开始预热）。
   */
  ingestPlaylist(url: string, text: string): void {
    if (!this.episode || !url || !text) return;
    this.captured.set(url, text);
    this.notifyCapture();
    // master 清单不能按 media 解析（里面没有分片），交给选档逻辑处理
    if (text.includes('#EXT-X-STREAM-INF')) return;
    // 还没拿到档位信息时，先把第一份 media 清单当作当前档位
    // （单码率源只有这一份；多码率源随后会被 LEVEL_SWITCHED 纠正）
    if (!this.levelUrl) this.levelUrl = url;
    const isCurrent = this.levelUrl === url;
    if (!isCurrent) return;
    void this.adoptCaptured(url, text);
  }

  /** 当前档位的 media 清单地址（清单变化时预取器需要重建窗口） */
  getPlaylistKey(): string {
    return this.levelUrl ?? '';
  }

  /** 当前清单解析结果（命中缓存时零网络往返） */
  async getPlaylist(): Promise<ParsedPlaylist> {
    if (this.playlist) return this.playlist;
    if (this.playlistPromise) return this.playlistPromise;
    const promise = this.resolvePlaylist();
    this.playlistPromise = promise;
    try {
      const parsed = await promise;
      // 解析期间可能已经换档/换集：这时不要把旧清单写回当前状态
      // 空清单不落状态：否则预取被临时关掉后，「当前清单」会卡在空壳上
      if (this.playlistPromise === promise && parsed.segments.length) this.playlist = parsed;
      return parsed;
    } finally {
      if (this.playlistPromise === promise) this.playlistPromise = undefined;
    }
  }

  /**
   * 预取总闸门：本地缓存开关 + 用户网络偏好（省流量 / 2G）。
   *
   * ★ 所有新增的预取路径（起播压 / seek 预取 / 换档预热 / 清单预热）
   *   都必须先过这一关：用户在省流量模式或 2G 下开着软件，
   *   不能被新逻辑偷偷把流量跑满——这是既有前向预取的约定，也是回归红线。
   */
  private prefetchAllowed(): boolean {
    const settings = loadCacheSettings();
    if (!settings.enabled) return false;
    return shouldPrefetch();
  }

  /**
   * seek 预取：把目标位置附近的分片拉下来。
   *
   * 拖动时进度条每移动一次都会触发一次，这里按节流窗口开跑：
   * 首次立刻开跑（不等用户松手），后续最多每 SEEK_THROTTLE_MS 一次，
   * 每次都用最新落点。旧轮次软停止——正在下的那一片照常落盘（那正是最需要的），
   * 只是不再往下铺。
   */
  prefetchSeek(targetTime: number): void {
    if (!this.episode || !Number.isFinite(targetTime)) return;
    if (!this.prefetchAllowed()) return;
    this.seekTarget = targetTime;
    if (this.seekTimer) return;
    const delay = computeSeekStartDelay(this.seekRunAt, Date.now());
    this.seekTimer = setTimeout(() => {
      this.seekTimer = undefined;
      this.seekRunAt = Date.now();
      const target = this.seekTarget;
      this.seekTarget = undefined;
      if (target !== undefined) void this.runSeekPrefetch(target);
    }, delay);
  }

  /** 预热指定位置附近（恢复播放位置、换档位后用） */
  warmAround(time: number): void {
    if (!this.episode || !Number.isFinite(time)) return;
    if (!this.prefetchAllowed()) return;
    void this.runSeekPrefetch(time);
  }

  /** 换集/卸载：中止全部预热并清空状态 */
  stop(): void {
    this.reset();
  }

  // —— 内部实现 ——

  private reset(): void {
    this.stopped = true;
    this.episode = undefined;
    this.levelUrl = undefined;
    this.captured.clear();
    this.playlist = undefined;
    this.playlistPromise = undefined;
    this.cancelCaptureWaiters();
    this.seekTarget = undefined;
    this.seekRunAt = 0;
    this.seekGeneration += 1;
    if (this.seekTimer) {
      clearTimeout(this.seekTimer);
      this.seekTimer = undefined;
    }
    this.seekAbort?.abort();
    this.seekAbort = undefined;
    this.startupAbort?.abort();
    this.startupAbort = undefined;
    clearSegmentFetchRegistry(this.owner);
  }

  private notifyCapture(): void {
    for (const waiter of [...this.captureWaiters]) waiter.check();
  }

  private cancelCaptureWaiters(): void {
    const waiters = this.captureWaiters.splice(0);
    for (const waiter of waiters) waiter.cancel();
  }

  /**
   * 等待 loader 捕获到清单文本。
   * hls.js 正在拉的那份清单等它就好：自己再拉一次是纯浪费（同一地址两次往返）。
   */
  private waitForCapture(url: string | undefined, timeoutMs: number): Promise<{ url: string; text: string } | null> {
    const pick = (): { url: string; text: string } | null => {
      if (url) {
        const text = this.captured.get(url);
        return text ? { url, text } : null;
      }
      let latest: { url: string; text: string } | null = null;
      for (const [key, text] of this.captured) latest = { url: key, text };
      return latest;
    };
    const immediate = pick();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let settled = false;
      // 用 holder 兜住定时器与等待者：两者都要在 finish 之前存在
      const holder: { timer?: ReturnType<typeof setTimeout>; waiter?: CaptureWaiter } = {};
      const cleanup = () => {
        if (!holder.waiter) return;
        const idx = this.captureWaiters.indexOf(holder.waiter);
        if (idx >= 0) this.captureWaiters.splice(idx, 1);
      };
      const finish = (value: { url: string; text: string } | null) => {
        if (settled) return;
        settled = true;
        if (holder.timer) clearTimeout(holder.timer);
        cleanup();
        resolve(value);
      };
      holder.waiter = {
        check: () => {
          const found = pick();
          if (found) finish(found);
        },
        cancel: () => finish(null),
      };
      holder.timer = setTimeout(() => finish(null), timeoutMs);
      this.captureWaiters.push(holder.waiter);
    });
  }

  /** 解析并采用一份捕获到的 media 清单 */
  private async adoptCaptured(url: string, text: string): Promise<void> {
    const ep = this.episode;
    if (!ep) return;
    try {
      const parsed = await parseCapturedPlaylist(text, url, { stripLeadAd: this.stripLeadAd });
      if (this.stopped || !this.episode) return;
      // 解析期间换档了：这份清单已经过期，交给新的档位流程处理
      if (this.levelUrl && this.levelUrl !== url) return;
      this.playlist = parsed;
      await cacheMediaPlaylist(ep.m3u8Url, ep.episodeKey, url, parsed);
      if (this.stopped) return;
      await this.warmStartupSegments(parsed);
    } catch {
      // 清单解析失败不影响播放：播放器自己的链路仍在跑
    }
  }

  /** 解析顺序：loader 捕获的当前档位 → 清单缓存 → 网络 */
  private async resolvePlaylist(): Promise<ParsedPlaylist> {
    const ep = this.episode;
    if (!ep) throw new Error('加速器尚未初始化剧集');
    // 省流量 / 2G：连清单都不去拉（拉清单本身就是一次网络往返）
    if (!this.prefetchAllowed()) return EMPTY_PLAYLIST;
    const levelUrl = this.levelUrl;
    if (levelUrl) {
      const raw = this.captured.get(levelUrl);
      const captured = raw ? { url: levelUrl, text: raw } : await this.waitForCapture(levelUrl, CAPTURE_WAIT_MS);
      if (captured && !captured.text.includes('#EXT-X-STREAM-INF')) {
        const parsed = await parseCapturedPlaylist(captured.text, captured.url, {
          stripLeadAd: this.stripLeadAd,
        });
        await cacheMediaPlaylist(ep.m3u8Url, ep.episodeKey, captured.url, parsed);
        return parsed;
      }
    }
    return getPlaylistWithCache({
      m3u8Url: ep.m3u8Url,
      episodeKey: ep.episodeKey,
      mediaUrl: levelUrl,
      preferredBitrate: this.preferredBitrate,
      stripLeadAd: this.stripLeadAd,
    });
  }

  /** 缓存命中时：起播即可预热（上次进入已解析过清单，分片多半已在本地） */
  private async warmFromCache(): Promise<void> {
    const ep = this.episode;
    if (!ep) return;
    if (!this.prefetchAllowed()) return;
    const entry = await readPlaylistEntry(buildPlaylistCacheKey(ep.m3u8Url, ep.episodeKey));
    if (!isPlaylistCacheFresh(entry, Date.now())) return;
    const mediaUrl = entry?.lastMediaUrl;
    if (!mediaUrl) return;
    const media = entry?.media?.[mediaUrl];
    if (!media?.segments?.length) return;
    if (this.stopped) return;
    await this.warmStartupSegments(fromCachedMedia(media, entry?.variants));
  }

  /**
   * 起播预热：首批分片与 hls.js 的分片请求并行。
   *
   * ★ 会不会跟 hls.js 重复下载同一片？不会：
   *   - 预热与 loader 用的是同一套缓存键（buildSegmentCacheKey），天然去重；
   *   - segment-warmer 的在途登记表保证「同一片只下一次」；
   *   - loader 发现该片正在被预取时，会等它落盘后直接复用（见 hls-loader）。
   *   - 缓存写入只有预热侧一处（putCachedSegmentResilient），loader 只读不写 → 不会双写。
   */
  private async warmStartupSegments(playlist: ParsedPlaylist): Promise<void> {
    const ep = this.episode;
    if (!ep || playlist.byterange) return;
    if (!this.prefetchAllowed()) return;
    const items: WarmSegmentItem[] = [];
    for (let i = 0; i < Math.min(STARTUP_WARM_SEGMENTS, playlist.segments.length); i++) {
      items.push({ url: playlist.segments[i].url, index: i + 1 });
    }
    if (!items.length) return;
    this.startupAbort?.abort();
    const controller = new AbortController();
    this.startupAbort = controller;
    await warmSegments(items, {
      episodeKey: ep.episodeKey,
      settings: loadCacheSettings(),
      signal: controller.signal,
      owner: this.owner,
      concurrency: STARTUP_WARM_SEGMENTS,
    });
  }

  /** seek 预取：并发下载目标位置附近的分片 */
  private async runSeekPrefetch(targetTime: number): Promise<void> {
    const ep = this.episode;
    if (!ep) return;
    if (!this.prefetchAllowed()) return;
    const generation = ++this.seekGeneration;
    let playlist: ParsedPlaylist;
    try {
      playlist = await this.getPlaylist();
    } catch {
      return;
    }
    if (this.stopped || !this.episode || generation !== this.seekGeneration) return;
    if (playlist.byterange) return;

    const durations = playlist.segments.map((s) => s.duration);
    // 窗口复用前向预取的同一套算法：seek 落点当作锚点，
    // horizon = 前瞻秒数（拖过去之后要连着播的那一段），lookBehind = 回看秒数
    const { fromIdx, toIdx } = computeWindow(
      durations,
      targetTime,
      SEEK_LOOK_AHEAD_SECONDS,
      SEEK_LOOK_BEHIND_SECONDS
    );
    const targetIdx = indexAtTime(durations, targetTime);
    const order = buildSeekOrder(fromIdx, toIdx, targetIdx);
    if (!order.length) return;
    const items = order.map((i) => ({ url: playlist.segments[i].url, index: i + 1 }));

    const settings = loadCacheSettings();
    // 落点变了就换一轮：旧轮次不再往下铺（已开下的那一片照常落盘）
    await warmSegments(items, {
      episodeKey: ep.episodeKey,
      settings,
      signal: this.seekAbort?.signal,
      shouldContinue: () => generation === this.seekGeneration,
      owner: this.owner,
      concurrency: SEEK_WARM_CONCURRENCY,
    });
  }
}

/** 全站单例：当前播放会话的加速器 */
let currentAccelerator: VideoAccelerator | undefined;
export function getVideoAccelerator(): VideoAccelerator {
  currentAccelerator ??= new VideoAccelerator();
  return currentAccelerator;
}
