import { describe, expect, it } from 'vitest';
import {
  deriveEpisodeKeyFromUrl,
  DIRECT_EPISODE_KEY_PREFIX,
  hashString,
  isVolatileParam,
  resolveEpisodeKey,
  stripVolatileParams,
} from './episode-key';

describe('deriveEpisodeKeyFromUrl', () => {
  it('同一地址每次派生结果一致（稳定）', () => {
    const url = 'http://127.0.0.1:8091/lng.m3u8';
    expect(deriveEpisodeKeyFromUrl(url)).toBe(deriveEpisodeKeyFromUrl(url));
  });

  it('带 direct: 前缀，与搜索结果路径的 source:vodId:index 不冲突', () => {
    const key = deriveEpisodeKeyFromUrl('http://cdn.example.com/a.m3u8');
    expect(key.startsWith(DIRECT_EPISODE_KEY_PREFIX)).toBe(true);
    // 搜索结果路径的键不含冒号前缀格式，不会撞车
    expect(key).not.toBe('src:vod:0');
  });

  it('不同地址 → 不同键', () => {
    expect(deriveEpisodeKeyFromUrl('http://cdn.example.com/a.m3u8')).not.toBe(
      deriveEpisodeKeyFromUrl('http://cdn.example.com/b.m3u8')
    );
  });

  it('短时效签名参数变化不影响派生键', () => {
    const a = deriveEpisodeKeyFromUrl('http://cdn.example.com/a.m3u8?sign=abc123&t=1730000000');
    const b = deriveEpisodeKeyFromUrl('http://cdn.example.com/a.m3u8?sign=zzz999&t=1760000000');
    expect(a).toBe(b);
  });

  it('稳定参数（id / url）变化会影响派生键', () => {
    const a = deriveEpisodeKeyFromUrl('http://cdn.example.com/play?id=1');
    const b = deriveEpisodeKeyFromUrl('http://cdn.example.com/play?id=2');
    expect(a).not.toBe(b);
  });

  it('代理形态：内层 url 里的签名变化也不影响派生键', () => {
    const inner = (sign: string) => encodeURIComponent(`http://cdn.example.com/a.m3u8?sign=${sign}&t=1730000000`);
    const a = deriveEpisodeKeyFromUrl(`/api/proxy?url=${inner('aaa')}`);
    const b = deriveEpisodeKeyFromUrl(`/api/proxy?url=${inner('bbb')}`);
    expect(a).toBe(b);
  });

  it('代理形态：内层真实地址不同 → 派生键不同', () => {
    const a = deriveEpisodeKeyFromUrl(`/api/proxy?url=${encodeURIComponent('http://cdn.example.com/a.m3u8')}`);
    const b = deriveEpisodeKeyFromUrl(`/api/proxy?url=${encodeURIComponent('http://cdn.example.com/b.m3u8')}`);
    expect(a).not.toBe(b);
  });

  it('地址为空 → 空键（调用方据此关闭加速）', () => {
    expect(deriveEpisodeKeyFromUrl('')).toBe('');
    expect(deriveEpisodeKeyFromUrl('   ')).toBe('');
  });
});

describe('isVolatileParam', () => {
  it('已知短时效参数名', () => {
    expect(isVolatileParam('sign', 'abc')).toBe(true);
    expect(isVolatileParam('SIGN', 'abc')).toBe(true);
    expect(isVolatileParam('token', 'abc')).toBe(true);
    expect(isVolatileParam('t', '1730000000')).toBe(true);
    expect(isVolatileParam('expires', '1730000000')).toBe(true);
  });

  it('云厂商签名参数（名字带 x- 前缀）', () => {
    expect(isVolatileParam('X-Amz-Signature', 'abc')).toBe(true);
    expect(isVolatileParam('x-oss-date', '20240101')).toBe(true);
  });

  it('值是时间戳形态（参数名不认识也会变）', () => {
    expect(isVolatileParam('whatever', '1730000000')).toBe(true);
    expect(isVolatileParam('whatever', '1730000000000')).toBe(true);
  });

  it('稳定参数不算短时效', () => {
    expect(isVolatileParam('id', '123')).toBe(false);
    expect(isVolatileParam('url', 'http://cdn.example.com/a.m3u8')).toBe(false);
    expect(isVolatileParam('title', '第 1 集')).toBe(false);
  });
});

describe('stripVolatileParams', () => {
  it('剥掉短时效参数，保留稳定参数', () => {
    const out = stripVolatileParams('http://cdn.example.com/a.m3u8?sign=abc&t=123&id=9');
    expect(out).toContain('id=9');
    expect(out).not.toContain('sign=');
    expect(out).not.toContain('t=123');
  });

  it('相对地址（代理形态）也能规范化', () => {
    const out = stripVolatileParams('/api/proxy?url=http%3A%2F%2Fcdn.example.com%2Fa.m3u8&sign=x');
    expect(out.startsWith('http://libretv.local/api/proxy')).toBe(true);
    expect(out).not.toContain('sign=');
  });

  it('去掉 fragment（不参与请求，与资源身份无关）', () => {
    expect(stripVolatileParams('http://cdn.example.com/a.m3u8#frag')).not.toContain('#');
  });

  it('空串 → 空串', () => {
    expect(stripVolatileParams('')).toBe('');
  });
});

describe('hashString', () => {
  it('稳定且区分不同输入', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('固定长度十六进制', () => {
    expect(hashString('abc')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('resolveEpisodeKey', () => {
  it('显式给的键优先（搜索结果路径 / ?ep=）', () => {
    expect(resolveEpisodeKey('src:vod:0', 'http://cdn.example.com/a.m3u8')).toBe('src:vod:0');
  });

  it('没给 → 按地址派生（直链场景零配置走加速）', () => {
    const derived = resolveEpisodeKey(undefined, 'http://cdn.example.com/a.m3u8');
    expect(derived).toBe(deriveEpisodeKeyFromUrl('http://cdn.example.com/a.m3u8'));
  });

  it('空白串视为没给', () => {
    expect(resolveEpisodeKey('   ', 'http://cdn.example.com/a.m3u8')).toBe(
      deriveEpisodeKeyFromUrl('http://cdn.example.com/a.m3u8')
    );
  });

  it('两者都没有 → 空串', () => {
    expect(resolveEpisodeKey(undefined, '')).toBe('');
  });
});
