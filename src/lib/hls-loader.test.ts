import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type HlsType from 'hls.js';

/**
 * node 环境没有 IndexedDB，db.segmentMeta.get 会抛错，
 * 而 readCachedSegment 把整个读取包在一个 try 里 → 读不到任何缓存条目。
 * 这里给一个最小实现，让「缓存命中路径」在测试里真实可跑。
 */
vi.mock('./db', () => ({
  db: {
    segmentMeta: {
      get: async () => undefined,
      put: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      bulkDelete: async () => undefined,
      toArray: async () => [],
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
    },
  },
}));

import { createHlsLoader } from './hls-loader';
import { buildSegmentCacheKey, type CacheSettings } from './video-cache';
import { clearSegmentFetchRegistry, peekInFlightSegment, warmSegment } from './segment-warmer';
import { stripAdGroups } from './m3u8';

/** 最小可用的 Cache Storage 替身 */
class FakeCache {
  store = new Map<string, ArrayBuffer>();
  async match(key: string): Promise<Response | undefined> {
    const data = this.store.get(key);
    return data ? new Response(data) : undefined;
  }
  async put(key: string, res: Response): Promise<void> {
    this.store.set(key, await res.arrayBuffer());
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

/** hls.js 基类 loader 的替身：记录是否真的回源过 */
class BaseLoader {
  static DefaultConfig = { loader: BaseLoader };
  stats: Record<string, unknown> = {};
  networkLoads = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load(context: any, config: any, callbacks: any): void {
    this.networkLoads += 1;
    // 播放列表是文本，分片是二进制
    const isPlaylist = context.type === 'manifest' || context.type === 'level';
    const data = isPlaylist ? playlistPayload : new TextEncoder().encode('from-network');
    callbacks.onSuccess({ url: context.url, data }, this.stats, context, undefined);
  }
  abort(): void {}
  destroy(): void {}
}

/** 基类 loader 回源时返回的清单文本（每个用例可改） */
let playlistPayload = '#EXTM3U\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST';

const FakeHls = { DefaultConfig: { loader: BaseLoader } } as unknown as typeof HlsType;

const SETTINGS: CacheSettings = {
  enabled: true,
  horizonSeconds: 300,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxConcurrency: 3,
};

let fakeCache: FakeCache;

beforeEach(() => {
  fakeCache = new FakeCache();
  vi.stubGlobal('caches', { open: async () => fakeCache });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSegmentFetchRegistry();
});

describe('hls loader · 缓存命中路径', () => {
  it('本地已有该分片：直接合成响应，不回源', async () => {
    const url = 'https://cdn.example.com/seg1.ts';
    const key = buildSegmentCacheKey(url);
    fakeCache.store.set(key, new TextEncoder().encode('cached-bytes').buffer as ArrayBuffer);

    const fetchMock = vi.fn(async () => new Response('network'));
    vi.stubGlobal('fetch', fetchMock);

    const Loader = createHlsLoader(FakeHls, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new (Loader as any)({}) as any;
    let payload: { data: ArrayBuffer } | null = null;
    loader.load({ type: 'fragment', url }, {}, { onSuccess: (v: { data: ArrayBuffer }) => { payload = v; } });

    await vi.waitFor(() => expect(payload).toBeTruthy());
    expect(new TextDecoder().decode(payload!.data)).toBe('cached-bytes');
    // 命中缓存：一次网络请求都不该发生
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loader.networkLoads).toBe(0);
  });

  it('分片正在被预取：等它落盘后复用，不重复下载', async () => {
    const url = 'https://cdn.example.com/seg2.ts';
    const key = buildSegmentCacheKey(url);
    const fetchMock = vi.fn(async () => new Response(new TextEncoder().encode('fresh-bytes')));
    vi.stubGlobal('fetch', fetchMock);

    // 预取器正在下载这一片
    const pending = warmSegment(url, {
      episodeKey: 's:v:0',
      index: 1,
      settings: SETTINGS,
      owner: 'test',
    });
    await vi.waitFor(() => expect(peekInFlightSegment(key)).toBeDefined());

    const Loader = createHlsLoader(FakeHls, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new (Loader as any)({}) as any;
    let payload: { data: ArrayBuffer } | null = null;
    loader.load({ type: 'fragment', url }, {}, { onSuccess: (v: { data: ArrayBuffer }) => { payload = v; } });

    await pending;
    await vi.waitFor(() => expect(payload).toBeTruthy());

    // 整个过程只下载了一次（预取那次），loader 没有再回源
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loader.networkLoads).toBe(0);
    expect(new TextDecoder().decode(payload!.data)).toBe('fresh-bytes');
  });

  it('缓存没有、也没有在途预取：正常回源', async () => {
    const url = 'https://cdn.example.com/seg3.ts';
    const fetchMock = vi.fn(async () => new Response('network'));
    vi.stubGlobal('fetch', fetchMock);

    const Loader = createHlsLoader(FakeHls, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new (Loader as any)({}) as any;
    let payload: unknown = null;
    loader.load({ type: 'fragment', url }, {}, { onSuccess: (v: unknown) => { payload = v; } });

    await vi.waitFor(() => expect(payload).toBeTruthy());
    expect(loader.networkLoads).toBe(1);
  });
});

describe('hls loader · 清单捕获路径', () => {
  const PLAYLIST = '#EXTM3U\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST';

  beforeEach(() => {
    playlistPayload = PLAYLIST;
  });

  it('把清单原文交给加速器（原始文本，不做广告剔除）', () => {
    const onPlaylist = vi.fn();
    const Loader = createHlsLoader(FakeHls, { onPlaylist });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new (Loader as any)({}) as any;
    let payload: { data: string } | null = null;
    loader.load(
      { type: 'manifest', url: 'https://cdn.example.com/index.m3u8' },
      {},
      { onSuccess: (v: { data: string }) => { payload = v; } }
    );

    expect(onPlaylist).toHaveBeenCalledWith('https://cdn.example.com/index.m3u8', PLAYLIST);
    // 没有开广告过滤时原样透传给 hls.js
    expect(payload!.data).toBe(PLAYLIST);
  });

  it('开启广告过滤时：捕获原文、透传剔除后的文本', () => {
    const onPlaylist = vi.fn();
    const Loader = createHlsLoader(FakeHls, { onPlaylist, blockAd: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new (Loader as any)({}) as any;
    let payload: { data: string } | null = null;
    loader.load(
      { type: 'manifest', url: 'https://cdn.example.com/index.m3u8' },
      {},
      { onSuccess: (v: { data: string }) => { payload = v; } }
    );

    // 加速器拿到的必须是原文（它自己按播放器开关决定要不要剔广告）
    expect(onPlaylist).toHaveBeenCalledWith('https://cdn.example.com/index.m3u8', PLAYLIST);
    // 播放器侧拿到的仍是剔除后的文本（行为不变）
    expect(payload!.data).toBe(stripAdGroups(PLAYLIST));
  });

  it('捕获回调抛错不影响播放（异常被吞掉）', () => {
    const onPlaylist = vi.fn(() => {
      throw new Error('capture failed');
    });
    const Loader = createHlsLoader(FakeHls, { onPlaylist });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new (Loader as any)({}) as any;
    let payload: unknown = null;
    loader.load(
      { type: 'manifest', url: 'https://cdn.example.com/index.m3u8' },
      {},
      { onSuccess: (v: unknown) => { payload = v; } }
    );
    expect(payload).toBeTruthy();
  });
});
