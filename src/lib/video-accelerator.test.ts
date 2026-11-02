import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSeekOrder,
  computeSeekStartDelay,
  isSignificantJump,
  SEEK_LOOK_AHEAD_SECONDS,
  SEEK_LOOK_BEHIND_SECONDS,
  SEEK_THROTTLE_MS,
  SEEK_TRIGGER_JUMP_SECONDS,
  VideoAccelerator,
} from './video-accelerator';
import { computeWindow, indexAtTime } from './video-prefetcher';
import { clearSegmentFetchRegistry } from './segment-warmer';
import { clearPlaylistCache } from './m3u8-cache';

afterEach(async () => {
  vi.unstubAllGlobals();
  clearSegmentFetchRegistry();
  await clearPlaylistCache();
});

describe('seek 窗口复用前向预取的 computeWindow', () => {
  const durations = [10, 10, 10, 10, 10]; // 总长 50s

  it('落点作为锚点：回看 SEEK_LOOK_BEHIND_SECONDS、前瞻 SEEK_LOOK_AHEAD_SECONDS', () => {
    // 加速器不再自造窗口算法：窗口完全由共享的 computeWindow 求出
    const expected = computeWindow(durations, 25, SEEK_LOOK_AHEAD_SECONDS, SEEK_LOOK_BEHIND_SECONDS);
    const expectedTarget = indexAtTime(durations, 25);

    expect(expected.fromIdx).toBe(0);
    expect(expected.toIdx).toBe(5);
    expect(expectedTarget).toBe(2);
  });

  it('锚点落在片尾时窗口收敛在片尾', () => {
    const { fromIdx, toIdx } = computeWindow(durations, 999, SEEK_LOOK_AHEAD_SECONDS, SEEK_LOOK_BEHIND_SECONDS);
    expect(toIdx).toBe(5);
    expect(fromIdx).toBeLessThanOrEqual(4);
    expect(indexAtTime(durations, 999)).toBe(4);
  });

  it('空清单 → 空窗口（不越界）', () => {
    const { fromIdx, toIdx } = computeWindow([], 10, SEEK_LOOK_AHEAD_SECONDS, SEEK_LOOK_BEHIND_SECONDS);
    expect(fromIdx).toBe(0);
    expect(toIdx).toBe(0);
  });
});

describe('buildSeekOrder', () => {
  it('目标分片排第一，然后向前铺，最后回看', () => {
    expect(buildSeekOrder(1, 5, 3)).toEqual([3, 4, 2, 1]);
  });

  it('目标在窗口起点时只向前铺', () => {
    expect(buildSeekOrder(2, 4, 2)).toEqual([2, 3]);
  });

  it('目标超出窗口时被钳制到窗口内', () => {
    expect(buildSeekOrder(0, 3, 99)).toEqual([2, 1, 0]);
    expect(buildSeekOrder(0, 3, -5)).toEqual([0, 1, 2]);
  });

  it('空窗口返回空数组', () => {
    expect(buildSeekOrder(3, 3, 3)).toEqual([]);
  });
});

describe('isSignificantJump', () => {
  it('普通播放的逐拍位移不算跳变', () => {
    expect(isSignificantJump(0.25)).toBe(false);
    expect(isSignificantJump(1.5)).toBe(false);
  });

  it('拖动/恢复进度造成的大幅位移算跳变', () => {
    expect(isSignificantJump(120)).toBe(true);
    expect(isSignificantJump(-120)).toBe(true);
    expect(isSignificantJump(SEEK_TRIGGER_JUMP_SECONDS)).toBe(true);
  });

  it('非法数值不算跳变', () => {
    expect(isSignificantJump(Number.NaN)).toBe(false);
    expect(isSignificantJump(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('computeSeekStartDelay', () => {
  const now = 1_700_000_000_000;

  it('首次立即开跑（不等防抖窗口）', () => {
    expect(computeSeekStartDelay(0, now)).toBe(0);
  });

  it('上一轮刚跑过：按节流窗口等待', () => {
    expect(computeSeekStartDelay(now - 20, now)).toBe(SEEK_THROTTLE_MS - 20);
  });

  it('上一轮跑完已久：立即开跑', () => {
    expect(computeSeekStartDelay(now - 10_000, now)).toBe(0);
  });
});

describe('VideoAccelerator · seek 预取', () => {
  const SEG_BASE = 'https://cdn.example.com/';
  const M3U8_URL = `${SEG_BASE}index.m3u8`;
  const SEG_COUNT = 30;
  const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    ...Array.from({ length: SEG_COUNT }, (_, i) => `#EXTINF:10.0,\n${SEG_BASE}seg${i + 1}.ts`),
    '#EXT-X-ENDLIST',
  ].join('\n');

  function stubNetwork(segUrls: string[]) {
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch', head: { appendChild: () => {} } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('.m3u8')) return new Response(PLAYLIST, { status: 200 });
      segUrls.push(url);
      return new Response(new ArrayBuffer(64), { status: 200 });
    }));
  }

  it('拖到中段后并发下载落点附近的分片（目标分片优先）', async () => {
    const segUrls: string[] = [];
    stubNetwork(segUrls);
    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: M3U8_URL, episodeKey: 's:v:0' });

    // 落点 150s → 第 16 片（每片 10s，150s 是第 16 片（0 基 15）的起点）
    accelerator.warmAround(150);
    await vi.waitFor(() => expect(segUrls.length).toBeGreaterThan(0));

    // 落点 150s：indexAtTime 的边界约定（累计结束 ≥ t）落在第 15 片；
    // 播放器在 150s 实际要的第 16 片紧随其后（第 2 位），一样会被预取到
    const durations = new Array(SEG_COUNT).fill(10);
    const targetIdx = indexAtTime(durations, 150);
    expect(segUrls[0]).toBe(`${SEG_BASE}seg${targetIdx + 1}.ts`);
    // 落点之后的分片也要被覆盖（前瞻窗口内）
    expect(segUrls.some((u) => u === `${SEG_BASE}seg${targetIdx + 2}.ts`)).toBe(true);
    // 远离落点的分片不下载（不做无谓的全片预取）
    expect(segUrls.some((u) => u === `${SEG_BASE}seg2.ts`)).toBe(false);

    accelerator.stop();
  });

  it('未初始化剧集时预取是空操作', async () => {
    const segUrls: string[] = [];
    stubNetwork(segUrls);
    const accelerator = new VideoAccelerator();
    await accelerator.warmAround(100);
    expect(segUrls).toHaveLength(0);
    accelerator.stop();
  });

  it('没有 episodeKey 时按地址派生剧集键，直链场景照样加速', async () => {
    const segUrls: string[] = [];
    stubNetwork(segUrls);
    const accelerator = new VideoAccelerator();
    // 不给 episodeKey（直链播放场景）
    accelerator.startEpisode({ m3u8Url: M3U8_URL });
    accelerator.warmAround(150);
    await vi.waitFor(() => expect(segUrls.length).toBeGreaterThan(0));
    expect(segUrls.length).toBeGreaterThan(0);
    accelerator.stop();
  });

  it('stop 之后不再预取', async () => {
    const segUrls: string[] = [];
    stubNetwork(segUrls);
    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: M3U8_URL, episodeKey: 's:v:0' });
    accelerator.stop();
    segUrls.length = 0;
    await accelerator.warmAround(150);
    await new Promise((r) => setTimeout(r, 50));
    expect(segUrls).toHaveLength(0);
  });

  it('拖动中连续触发：按最新落点开跑', async () => {
    const segUrls: string[] = [];
    stubNetwork(segUrls);
    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: M3U8_URL, episodeKey: 's:v:0' });

    accelerator.prefetchSeek(150);
    // 拖动继续：落点变了
    accelerator.prefetchSeek(250);
    await vi.waitFor(() => expect(segUrls.length).toBeGreaterThan(0));

    // 落点 250s 所在的分片排第一（每片 10s）
    const durations = new Array(SEG_COUNT).fill(10);
    const targetIdx = indexAtTime(durations, 250);
    expect(segUrls[0]).toBe(`${SEG_BASE}seg${targetIdx + 1}.ts`);
    accelerator.stop();
  });

  it('下载的分片集合 = computeWindow 求出的窗口（窗口算法只有一套）', async () => {
    const segUrls: string[] = [];
    stubNetwork(segUrls);
    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: M3U8_URL, episodeKey: 's:v:0' });

    const durations = new Array(SEG_COUNT).fill(10);
    const { fromIdx, toIdx } = computeWindow(
      durations,
      150,
      SEEK_LOOK_AHEAD_SECONDS,
      SEEK_LOOK_BEHIND_SECONDS
    );
    accelerator.warmAround(150);
    await vi.waitFor(() => expect(segUrls.length).toBeGreaterThan(0));
    // 等这一批跑完（窗口内所有分片都被拉过）
    await vi.waitFor(() => expect(segUrls.length).toBe(toIdx - fromIdx));

    const downloaded = new Set(segUrls.map((u) => u.replace(SEG_BASE, '')));
    for (let i = fromIdx; i < toIdx; i++) {
      expect(downloaded.has(`seg${i + 1}.ts`)).toBe(true);
    }
    // 窗口之外的分片不下载
    expect(downloaded.has('seg2.ts')).toBe(false);
    accelerator.stop();
  });
});

describe('VideoAccelerator · 省流量 / 2G 降级', () => {
  const LEVEL_URL = 'https://cdn.example.com/index.m3u8';
  const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10.0,',
    'seg1.ts',
    '#EXTINF:10.0,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  function stubAll(segUrls: string[]) {
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch', head: { appendChild: () => {} } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('.m3u8')) return new Response(PLAYLIST, { status: 200 });
      segUrls.push(url);
      return new Response(new ArrayBuffer(32), { status: 200 });
    }));
  }

  it('省流量模式：起播压 / seek 预取 / 换档预热全部不下载，也不拉清单', async () => {
    const segUrls: string[] = [];
    stubAll(segUrls);
    vi.stubGlobal('navigator', { connection: { saveData: true } });

    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: LEVEL_URL, episodeKey: 's:v:0' });
    // 起播压
    accelerator.ingestPlaylist(LEVEL_URL, PLAYLIST);
    // seek 预取
    accelerator.prefetchSeek(150);
    accelerator.warmAround(150);
    // 换档预热
    accelerator.setCurrentLevelUrl(LEVEL_URL, 150, 800_000);

    await new Promise((r) => setTimeout(r, 120));
    expect(segUrls).toHaveLength(0);
    accelerator.stop();
  });

  it('2G 网络：同样不预热', async () => {
    const segUrls: string[] = [];
    stubAll(segUrls);
    vi.stubGlobal('navigator', { connection: { effectiveType: '2g' } });

    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: LEVEL_URL, episodeKey: 's:v:0' });
    accelerator.ingestPlaylist(LEVEL_URL, PLAYLIST);
    accelerator.prefetchSeek(150);

    await new Promise((r) => setTimeout(r, 120));
    expect(segUrls).toHaveLength(0);
    accelerator.stop();
  });

  it('正常网络：预取照常进行（降级开关没把功能关死）', async () => {
    const segUrls: string[] = [];
    stubAll(segUrls);
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g' } });

    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: LEVEL_URL, episodeKey: 's:v:0' });
    accelerator.ingestPlaylist(LEVEL_URL, PLAYLIST);
    await vi.waitFor(() => expect(segUrls.length).toBeGreaterThan(0));
    accelerator.stop();
  });
});

describe('VideoAccelerator · 清单捕获', () => {
  const LEVEL_URL = 'https://cdn.example.com/v/720/index.m3u8';
  const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10.0,',
    'seg1.ts',
    '#EXTINF:10.0,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  it('loader 捕获的清单直接复用，分片地址与播放器侧收敛为同一个 key', async () => {
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch', head: { appendChild: () => {} } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(PLAYLIST, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: LEVEL_URL, episodeKey: 's:v:0' });
    accelerator.ingestPlaylist(LEVEL_URL, PLAYLIST);

    const playlist = await accelerator.getPlaylist();
    expect(playlist.segments).toHaveLength(2);
    // 分片地址由捕获到的清单文本 + 同一 base 解析而来
    expect(playlist.segments[0].url).toBe('https://cdn.example.com/v/720/seg1.ts');

    // 捕获路径不额外发清单请求（分片预热是另一回事，本来就该下）
    const manifestCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('.m3u8'));
    expect(manifestCalls).toHaveLength(0);
    accelerator.stop();
  });

  it('master 清单不会被当成 media 清单解析', async () => {
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch', head: { appendChild: () => {} } });
    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: LEVEL_URL, episodeKey: 's:v:0' });
    accelerator.ingestPlaylist(
      LEVEL_URL,
      ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'v0.m3u8'].join('\n')
    );
    // master 没有分片：不应被解析成 media（否则分片地址全是错的）
    expect(accelerator.getPlaylistKey()).toBe('');
    accelerator.stop();
  });

  it('换集后旧链路的迟到清单被丢弃', async () => {
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch', head: { appendChild: () => {} } });
    const accelerator = new VideoAccelerator();
    accelerator.startEpisode({ m3u8Url: LEVEL_URL, episodeKey: 's:v:0' });
    expect(accelerator.isCurrentEpisode(LEVEL_URL)).toBe(true);
    expect(accelerator.isCurrentEpisode('https://cdn.example.com/other.m3u8')).toBe(false);
    accelerator.stop();
  });
});
