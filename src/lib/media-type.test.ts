import { describe, it, expect } from 'vitest';
import { inferMediaType } from './media-type';

describe('inferMediaType', () => {
  it('m3u8 后缀 → m3u8', () => {
    expect(inferMediaType('https://a.com/v/index.m3u8')).toBe('m3u8');
    expect(inferMediaType('https://a.com/v/index.m3u')).toBe('m3u8');
  });

  it('mp4/webm/mov/mkv → mp4', () => {
    expect(inferMediaType('https://a.com/v/1.mp4')).toBe('mp4');
    expect(inferMediaType('https://a.com/v/1.webm')).toBe('mp4');
    expect(inferMediaType('https://a.com/v/1.mov')).toBe('mp4');
    expect(inferMediaType('https://a.com/v/1.mkv')).toBe('mp4');
  });

  it('★ 带签名查询串也要判对（直链常见 ?sign=&t=）', () => {
    expect(inferMediaType('https://a.com/v/1.mp4?sign=abc&t=1699')).toBe('mp4');
    expect(inferMediaType('https://a.com/v/index.m3u8?sign=abc&t=1699')).toBe('m3u8');
  });

  it('★ 伪静态 /m3u8/ 路径形式 → m3u8', () => {
    expect(inferMediaType('https://a.com/m3u8/abc/def')).toBe('m3u8');
  });

  it('代理形式（.m3u8 在查询串里）也认得出', () => {
    expect(inferMediaType('/api/proxy?url=https%3A%2F%2Fa.com%2F1.m3u8')).toBe('m3u8');
  });

  it('未知后缀按 m3u8 兜底（采集站默认形态，且有代理兜底）', () => {
    expect(inferMediaType('https://a.com/v/stream')).toBe('m3u8');
    expect(inferMediaType('https://a.com/v/abc.ts')).toBe('m3u8');
  });

  it('相对地址不抛错', () => {
    expect(inferMediaType('/api/proxy?url=x')).toBe('m3u8');
    expect(() => inferMediaType('')).not.toThrow();
  });
});
