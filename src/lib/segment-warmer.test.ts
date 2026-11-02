import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSegmentFetchRegistry,
  peekInFlightSegment,
  setFetchLimit,
  warmSegment,
  warmSegments,
} from './segment-warmer';
import { buildSegmentCacheKey, type CacheSettings } from './video-cache';

/** 最小可用的 Cache Storage 替身：只实现本模块用到的 match/put/delete */
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
  setFetchLimit(4);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSegmentFetchRegistry();
});

describe('warmSegment · 在途合并', () => {
  it('同一个分片的并发请求只下载一次', async () => {
    const fetchMock = vi.fn(async () => new Response(new ArrayBuffer(32), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const url = 'https://cdn.example.com/seg1.ts';
    const [a, b] = await Promise.all([
      warmSegment(url, { episodeKey: 's:v:0', index: 1, settings: SETTINGS, owner: 'test' }),
      warmSegment(url, { episodeKey: 's:v:0', index: 1, settings: SETTINGS, owner: 'test' }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.status).toBe(b.status);
  });

  it('在途登记可被查询（loader 侧据此避免重复下载）', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await hold;
      return new Response(new ArrayBuffer(32), { status: 200 });
    }));

    const url = 'https://cdn.example.com/seg2.ts';
    const key = buildSegmentCacheKey(url);
    expect(peekInFlightSegment(key)).toBeUndefined();

    const pending = warmSegment(url, { episodeKey: 's:v:0', index: 1, settings: SETTINGS, owner: 'test' });
    await vi.waitFor(() => expect(peekInFlightSegment(key)).toBeDefined());
    expect(peekInFlightSegment(key)).toBeDefined();

    release();
    await pending;
    // 结束后登记要清掉：否则下一轮会一直复用一个已完成的 Promise
    await vi.waitFor(() => expect(peekInFlightSegment(key)).toBeUndefined());
  });

  it('按 owner 清理只影响自己的记录', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await hold;
      return new Response(new ArrayBuffer(32), { status: 200 });
    }));

    const url = 'https://cdn.example.com/seg3.ts';
    const key = buildSegmentCacheKey(url);
    const pending = warmSegment(url, { episodeKey: 's:v:0', index: 1, settings: SETTINGS, owner: 'owner-a' });
    await vi.waitFor(() => expect(peekInFlightSegment(key)).toBeDefined());

    clearSegmentFetchRegistry('owner-b');
    expect(peekInFlightSegment(key)).toBeDefined();

    clearSegmentFetchRegistry('owner-a');
    expect(peekInFlightSegment(key)).toBeUndefined();

    release();
    await pending;
  });
});

describe('warmSegment · 缓存优先', () => {
  it('已缓存的分片直接跳过下载', async () => {
    const fetchMock = vi.fn(async () => new Response(new ArrayBuffer(32), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const url = 'https://cdn.example.com/seg4.ts';
    const key = buildSegmentCacheKey(url);
    fakeCache.store.set(key, new ArrayBuffer(8));

    const outcome = await warmSegment(url, { episodeKey: 's:v:0', index: 1, settings: SETTINGS, owner: 'test' });
    expect(outcome.status).toBe('cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('下载失败不抛错（返回 failed，由播放侧自己重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const outcome = await warmSegment('https://cdn.example.com/seg5.ts', {
      episodeKey: 's:v:0', index: 1, settings: SETTINGS, owner: 'test',
    });
    expect(outcome.status).toBe('failed');
  });

  it('存储配额满：返回 quota（调用方据此停止预取，不抛错）', async () => {
    const quotaError = new DOMException('quota exceeded', 'QuotaExceededError');
    const failingCache = {
      match: async () => undefined,
      put: async () => { throw quotaError; },
      delete: async () => false,
    };
    vi.stubGlobal('caches', { open: async () => failingCache });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(32), { status: 200 })));

    const outcome = await warmSegment('https://cdn.example.com/seg6.ts', {
      episodeKey: 's:v:0', index: 1, settings: SETTINGS, owner: 'test',
    });
    expect(outcome.status).toBe('quota');
  });
});

describe('warmSegments · 批量与并发', () => {
  it('并发不超过批次上限', async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return new Response(new ArrayBuffer(16), { status: 200 });
    }));

    const items = Array.from({ length: 8 }, (_, i) => ({
      url: `https://cdn.example.com/batch${i}.ts`,
      index: i + 1,
    }));
    const result = await warmSegments(items, {
      episodeKey: 's:v:0',
      settings: SETTINGS,
      owner: 'test',
      concurrency: 2,
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(result.warmed + result.failed).toBe(items.length);
  });

  it('软停止：条件为 false 时不再领取新分片', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      fetched.push(url);
      return new Response(new ArrayBuffer(16), { status: 200 });
    }));

    let allow = true;
    const items = Array.from({ length: 6 }, (_, i) => ({
      url: `https://cdn.example.com/soft${i}.ts`,
      index: i + 1,
    }));
    await warmSegments(items, {
      episodeKey: 's:v:0',
      settings: SETTINGS,
      owner: 'test',
      concurrency: 1,
      shouldContinue: () => allow,
    });
    const first = fetched.length;
    expect(first).toBeGreaterThan(0);

    allow = false;
    await warmSegments(items, {
      episodeKey: 's:v:0',
      settings: SETTINGS,
      owner: 'test',
      concurrency: 1,
      shouldContinue: () => allow,
    });
    // 条件为 false 时一个都不该再领
    expect(fetched.length).toBe(first);
  });
});
