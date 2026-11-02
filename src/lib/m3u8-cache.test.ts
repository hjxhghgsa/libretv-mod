import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlaylistCacheKey,
  clearPlaylistCache,
  fromCachedMedia,
  getPlaylistWithCache,
  isPlaylistCacheFresh,
  readPlaylistEntry,
  writePlaylistEntry,
  cacheMediaPlaylist,
  PLAYLIST_CACHE_TTL_MS,
} from './m3u8-cache';
import { parseM3u8Playlist } from './m3u8-parse';

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearPlaylistCache();
});

describe('buildPlaylistCacheKey', () => {
  it('清单地址 + 剧集标识共同决定 key', () => {
    expect(buildPlaylistCacheKey('https://a/1.m3u8', 's:v:0')).toBe('https://a/1.m3u8::s:v:0');
    // 同地址不同集 → 不同 key（避免串档）
    expect(buildPlaylistCacheKey('https://a/1.m3u8', 's:v:0')).not.toBe(
      buildPlaylistCacheKey('https://a/1.m3u8', 's:v:1')
    );
    // 不同地址同一集 → 不同 key（换源不复用）
    expect(buildPlaylistCacheKey('https://a/1.m3u8', 's:v:0')).not.toBe(
      buildPlaylistCacheKey('https://b/1.m3u8', 's:v:0')
    );
  });
});

describe('isPlaylistCacheFresh', () => {
  const now = 1_700_000_000_000;

  it('有效期内命中', () => {
    expect(isPlaylistCacheFresh({ createdAt: now - 1000 }, now)).toBe(true);
  });

  it('超过有效期不命中', () => {
    expect(isPlaylistCacheFresh({ createdAt: now - PLAYLIST_CACHE_TTL_MS - 1 }, now)).toBe(false);
    expect(isPlaylistCacheFresh({ createdAt: now - PLAYLIST_CACHE_TTL_MS }, now)).toBe(false);
  });

  it('缺失 / 非法条目一律不命中', () => {
    expect(isPlaylistCacheFresh(null, now)).toBe(false);
    expect(isPlaylistCacheFresh(undefined, now)).toBe(false);
    expect(isPlaylistCacheFresh({}, now)).toBe(false);
    expect(isPlaylistCacheFresh({ createdAt: Number.NaN }, now)).toBe(false);
  });

  it('时间戳在未来（时钟被调过）按过期处理', () => {
    expect(isPlaylistCacheFresh({ createdAt: now + 10_000 }, now)).toBe(false);
  });
});

describe('清单缓存命中判定', () => {
  const M3U8 = 'https://cdn.example.com/index.m3u8';
  const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10.0,',
    'seg1.ts',
    '#EXTINF:10.0,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  it('二次取同一份清单：命中缓存后不再发网络请求', async () => {
    const fetchMock = vi.fn(async () => new Response(PLAYLIST, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch' });

    const first = await getPlaylistWithCache({ m3u8Url: M3U8, episodeKey: 's:v:0' });
    expect(first.segments).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await getPlaylistWithCache({ m3u8Url: M3U8, episodeKey: 's:v:0' });
    expect(second.segments.map((s) => s.url)).toEqual(first.segments.map((s) => s.url));
    // 命中缓存 → 没有第二次网络请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('换集（episodeKey 不同）不复用缓存', async () => {
    const fetchMock = vi.fn(async () => new Response(PLAYLIST, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch' });

    await getPlaylistWithCache({ m3u8Url: M3U8, episodeKey: 's:v:0' });
    await getPlaylistWithCache({ m3u8Url: M3U8, episodeKey: 's:v:1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('缓存条目落库后能被读回，且记录最近使用的 media 清单地址', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PLAYLIST, { status: 200 })));
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch' });
    const parsed = await parseM3u8Playlist(M3U8);
    const mediaUrl = parsed.mediaUrl ?? M3U8;
    await cacheMediaPlaylist(M3U8, 's:v:0', mediaUrl, parsed);

    const entry = await readPlaylistEntry(buildPlaylistCacheKey(M3U8, 's:v:0'));
    expect(entry).toBeTruthy();
    expect(entry?.lastMediaUrl).toBe(mediaUrl);
    expect(entry?.media?.[mediaUrl]?.segments).toHaveLength(2);

    const restored = fromCachedMedia(entry!.media[mediaUrl]);
    expect(restored.segments.map((s) => s.url)).toEqual(parsed.segments.map((s) => s.url));
    expect(restored.totalDuration).toBe(parsed.totalDuration);
  });

  it('缓存过期后重新拉取', async () => {
    const fetchMock = vi.fn(async () => new Response(PLAYLIST, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/watch' });

    await getPlaylistWithCache({ m3u8Url: M3U8, episodeKey: 's:v:0' });
    // 把缓存条目改老：过期后必须重新走网络
    const key = buildPlaylistCacheKey(M3U8, 's:v:0');
    const entry = await readPlaylistEntry(key);
    expect(entry).toBeTruthy();
    await writePlaylistEntry({ ...entry!, createdAt: Date.now() - PLAYLIST_CACHE_TTL_MS - 1 });

    await getPlaylistWithCache({ m3u8Url: M3U8, episodeKey: 's:v:0' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
