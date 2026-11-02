import { describe, it, expect } from 'vitest';
import {
  findMusicSpans,
  proposeSkipSegments,
  describeSegments,
  type VolumeSample,
} from './intro-detector';

/** 合成音量曲线：interval 秒一个点 */
function build(points: Array<[number, number]>, interval = 0.25): VolumeSample[] {
  return points.map(([t, rms]) => ({ t, rms }));
}

/** 造一段「音乐」：给定起止秒，响度在 base 附近小幅抖动 */
function music(from: number, to: number, base = 0.12, interval = 0.25): VolumeSample[] {
  const out: VolumeSample[] = [];
  for (let t = from; t <= to; t += interval) {
    out.push({ t, rms: base + (Math.sin(t * 13.7) + 1) * 0.002 });
  }
  return out;
}

/** 造一段「对白」：响度起伏大 */
function dialog(from: number, to: number, interval = 0.25): VolumeSample[] {
  const out: VolumeSample[] = [];
  for (let t = from; t <= to; t += interval) {
    // 大方差：0.02 ~ 0.18 之间来回跳
    const v = 0.02 + 0.16 * Math.abs(Math.sin(t * 3.1) > 0.5 ? 0.95 : 0.05);
    out.push({ t, rms: v });
  }
  return out;
}

/** 造一段静音 */
function silence(from: number, to: number, interval = 0.25): VolumeSample[] {
  const out: VolumeSample[] = [];
  for (let t = from; t <= to; t += interval) out.push({ t, rms: 0.004 });
  return out;
}

describe('findMusicSpans', () => {
  it('找出「又响又稳又长」的音乐段', () => {
    const samples = [...dialog(0, 30), ...music(30, 100), ...dialog(100, 130)];
    const spans = findMusicSpans(samples);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBeLessThanOrEqual(30.5);
    expect(spans[0].end).toBeGreaterThanOrEqual(99.5);
  });

  it('太短的响段不算音乐段（< 50 秒）', () => {
    const samples = [...dialog(0, 30), ...music(30, 60), ...dialog(60, 130)];
    expect(findMusicSpans(samples)).toHaveLength(0);
  });

  it('响但不稳的段不算音乐段', () => {
    // 整段都响，但方差极大（模拟打斗/爆炸）
    const samples: VolumeSample[] = [];
    for (let t = 0; t <= 120; t += 0.25) {
      samples.push({ t, rms: 0.05 + 0.14 * Math.abs(Math.sin(t * 21)) });
    }
    expect(findMusicSpans(samples)).toHaveLength(0);
  });

  it('稳但不响的段不算音乐段', () => {
    const samples = music(0, 120, 0.02); // 很稳但很轻
    expect(findMusicSpans(samples)).toHaveLength(0);
  });

  it('采样点不足 3 个不判定（防噪声伪装）', () => {
    const samples = [
      { t: 0, rms: 0.12 },
      { t: 60, rms: 0.12 },
      { t: 120, rms: 0.12 },
    ];
    expect(findMusicSpans(samples)).toHaveLength(0);
  });

  it('合并间隔很近的段（OP 里的小过场不切成两半）', () => {
    const samples = [...music(0, 60), ...silence(60, 61.5), ...music(61.5, 120)];
    const spans = findMusicSpans(samples);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBeGreaterThanOrEqual(119.5);
  });

  it('间隔很远的段不合并', () => {
    const samples = [...music(0, 60), ...dialog(60, 100), ...music(100, 160)];
    expect(findMusicSpans(samples)).toHaveLength(2);
  });

  it('空输入/非法输入不抛错', () => {
    expect(findMusicSpans([])).toHaveLength(0);
    expect(findMusicSpans([{ t: Number.NaN, rms: 0.1 }])).toHaveLength(0);
  });
});

describe('proposeSkipSegments', () => {
  it('标准 24 分钟动画：识别出片头（前 20%）与片尾（后 25%）', () => {
    const D = 24 * 60; // 1440s
    const samples = [
      ...silence(0, 15),
      ...music(15, 105),        // OP：15s ~ 105s（90 秒）
      ...dialog(105, D - 105),
      ...music(D - 105, D - 15), // ED
      ...silence(D - 15, D),
    ];
    const segs = proposeSkipSegments(samples, D);
    const opening = segs.find((s) => s.type === 'opening');
    const ending = segs.find((s) => s.type === 'ending');
    expect(opening).toBeTruthy();
    expect(opening!.start).toBeGreaterThanOrEqual(14);
    expect(opening!.start).toBeLessThanOrEqual(20);
    expect(opening!.end).toBeGreaterThanOrEqual(100);
    expect(ending).toBeTruthy();
    // 片尾只取音乐段后 80%（ staff 表那一段不跳）
    expect(ending!.start).toBeGreaterThan(D - 105);
  });

  it('只有片头（正片无 ED 音乐）→ 只返回片头', () => {
    const D = 24 * 60;
    const samples = [...silence(0, 15), ...music(15, 105), ...dialog(105, D)];
    const segs = proposeSkipSegments(samples, D);
    expect(segs.filter((s) => s.type === 'opening')).toHaveLength(1);
    expect(segs.filter((s) => s.type === 'ending')).toHaveLength(0);
  });

  it('全程对白（电影/连续剧）→ 不误报', () => {
    const D = 90 * 60;
    const samples = dialog(0, D);
    expect(proposeSkipSegments(samples, D)).toHaveLength(0);
  });

  it('时长非法时返回空（不猜）', () => {
    expect(proposeSkipSegments([{ t: 0, rms: 0.1 }], 0)).toHaveLength(0);
    expect(proposeSkipSegments([{ t: 0, rms: 0.1 }], Number.NaN)).toHaveLength(0);
  });

  it('每类只取最长的一段（插曲不会被当成片头）', () => {
    const D = 24 * 60;
    const samples = [
      ...music(5, 55),          // 60s 插曲（短）
      ...dialog(55, 200),
      ...music(200, 280),       // OP 本体 80s（长）—— end 必须落在前 20%(288s) 内
      ...dialog(280, D),
    ];
    const segs = proposeSkipSegments(samples, D);
    const opening = segs.find((s) => s.type === 'opening');
    expect(opening).toBeTruthy();
    // 应该选 80 秒那段，而不是 60 秒那段
    expect(opening!.start).toBeGreaterThanOrEqual(199);
  });
});

describe('describeSegments', () => {
  it('格式化为 mm:ss 区间', () => {
    const s = describeSegments([
      { type: 'opening', start: 15, end: 105 },
      { type: 'ending', start: 1300, end: 1400 },
    ]);
    expect(s).toContain('片头 00:15 - 01:45');
    expect(s).toContain('片尾 21:40 - 23:20');
  });

  it('空结果有兜底文案', () => {
    expect(describeSegments([])).toBe('未检测到片头片尾');
  });
});
