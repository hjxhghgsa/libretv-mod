import { describe, it, expect } from 'vitest';
import { parseSegments, buildMergedPlaylist, relayStats, resetRelays } from './hls-relay';

const BASE = 'http://src.example.com/vod/';

describe('parseSegments', () => {
  it('解析普通分片清单：按序取出地址与 EXTINF 时长', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXTINF:4.000000,',
      'seg0.bin',
      '#EXTINF:4.000000,',
      'seg1.bin',
    ].join('\n');
    const { segments, isMaster, complete } = parseSegments(text, BASE);
    expect(isMaster).toBe(false);
    expect(complete).toBe(false);
    expect(segments).toEqual([
      { url: 'http://src.example.com/vod/seg0.bin', duration: 4 },
      { url: 'http://src.example.com/vod/seg1.bin', duration: 4 },
    ]);
  });

  it('识别 master playlist（含 #EXT-X-STREAM-INF）', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      'high/index.m3u8',
    ].join('\n');
    const { isMaster, segments } = parseSegments(text, BASE);
    expect(isMaster).toBe(true);
    // master 的子项不该被当成分片
    expect(segments).toHaveLength(0);
  });

  it('识别 #EXT-X-ENDLIST（静态源 → 停止周期刷新）', () => {
    const text = ['#EXTM3U', '#EXTINF:4.000000,', 'a.bin', '#EXT-X-ENDLIST'].join('\n');
    expect(parseSegments(text, BASE).complete).toBe(true);
  });

  it('相对地址基于传入 baseUrl 锚成绝对地址', () => {
    const text = ['#EXTM3U', '#EXTINF:4.000000,', '../other/a.bin'].join('\n');
    const { segments } = parseSegments(text, BASE);
    expect(segments[0].url).toBe('http://src.example.com/other/a.bin');
  });

  it('绝对地址原样保留', () => {
    const text = ['#EXTM3U', '#EXTINF:4.000000,', 'http://cdn.example.com/a.bin'].join('\n');
    const { segments } = parseSegments(text, BASE);
    expect(segments[0].url).toBe('http://cdn.example.com/a.bin');
  });

  it('EXTINF 缺失或非法按时长 0 计，不抛错', () => {
    const text = ['#EXTM3U', '#EXTINF:abc,', 'a.bin', 'b.bin'].join('\n');
    const { segments } = parseSegments(text, BASE);
    expect(segments.map((s) => s.duration)).toEqual([0, 0]);
  });

  it('#EXT-X-BYTERANGE：同一 URL 多次引用时按 offset 区分', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:2.000000,',
      '#EXT-X-BYTERANGE:1000@0',
      'big.bin',
      '#EXTINF:2.000000,',
      '#EXT-X-BYTERANGE:1000@1000',
      'big.bin',
    ].join('\n');
    const { segments } = parseSegments(text, BASE);
    expect(segments[0].url).toContain('#byte=0-999');
    expect(segments[1].url).toContain('#byte=1000-1999');
    expect(segments[0].url).not.toBe(segments[1].url);
  });

  it('忽略注释行与空行', () => {
    const text = ['#EXTM3U', '', '# 注释', '#EXTINF:4.0,', '', 'a.bin', ''].join('\n');
    expect(parseSegments(text, BASE).segments).toHaveLength(1);
  });
});

describe('buildMergedPlaylist', () => {
  it('输出完整清单：头 + 全部分片，分片地址走代理前缀', () => {
    const entry = {
      key: 'k',
      baseUrl: BASE,
      segments: [
        { url: 'http://src.example.com/vod/seg0.bin', duration: 4 },
        { url: 'http://src.example.com/vod/seg1.bin', duration: 4.5 },
      ],
      seen: new Set<string>(),
      complete: false,
      isMaster: false,
      lastAccess: 0,
      timer: null,
      cache: new Map(),
      cacheBytes: 0,
      inflight: new Set<string>(),
    };
    const out = buildMergedPlaylist(entry, '/api/proxy?url=');
    expect(out).toContain('#EXTM3U');
    expect(out).toContain('#EXT-X-TARGETDURATION:5'); // ceil(4.5)
    expect(out.match(/#EXTINF:/g)).toHaveLength(2);
    // 分片被代理化
    expect(out).toContain('/api/proxy?url=http%3A%2F%2Fsrc.example.com%2Fvod%2Fseg0.bin');
    expect(out).toContain('/api/proxy?url=http%3A%2F%2Fsrc.example.com%2Fvod%2Fseg1.bin');
    // ★ 故意不写 ENDLIST：动态源客户端还要继续刷新，但内容已是全部分片
    expect(out).not.toContain('#EXT-X-ENDLIST');
  });

  it('空清单也返回合法 m3u8（不抛错）', () => {
    const entry = {
      key: 'k', baseUrl: BASE, segments: [], seen: new Set<string>(),
      complete: false, isMaster: false, lastAccess: 0, timer: null,
      cache: new Map(), cacheBytes: 0, inflight: new Set<string>(),
    };
    const out = buildMergedPlaylist(entry, '/api/proxy?url=');
    expect(out).toContain('#EXTM3U');
    expect(out).toContain('#EXT-X-TARGETDURATION:1'); // 全 0 时兜底 1
  });
});

describe('relayStats / resetRelays', () => {
  it('初始为空，reset 不抛错', () => {
    resetRelays();
    const s = relayStats();
    expect(s.relays).toBe(0);
    expect(s.cachedSegments).toBe(0);
    expect(s.cacheBytes).toBe(0);
  });
});
