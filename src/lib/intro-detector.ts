/**
 * 片头片尾自动检测。
 *
 * ## 思路
 * OP/ED 的声学特征和正片对白很不一样：
 *   · **音乐段**：响度稳定（方差小）、整体偏响、持续时间长（60 秒以上）；
 *   · **对白段**：响度起伏大（方差大），还有静台词间隙。
 * 所以在音量曲线里找「又响又稳又长」的段，落在**前 20%** 的判为片头候选、
 * 落在**后 25%** 的判为片尾候选。
 *
 * ## 为什么必须用户确认
 * 这套启发式对标准 TV 动画有效，但碰上电影、连续剧、MV、直播就会误判。
 * 所以检测结果只作为**候选**弹给用户确认，绝不静默跳过 ——
 * 误跳 90 秒比不跳更烦人。确认后写入的仍是既有的 skipMark 机制。
 *
 * ## 实现约束
 * 采样走 Web Audio 的 AnalyserNode（只读 FFT，不额外解码，开销可忽略），
 * 这里只放纯函数部分，方便单测。
 */

import type { SkipSegment } from './skip-marks';

export interface VolumeSample {
  /** 采样时刻（秒） */
  t: number;
  /** 该时刻的 RMS 响度（0~1） */
  rms: number;
}

/** 音乐段判定：至少持续这么久（秒）—— 比 OP/ED 短的大多是插曲或过场 */
export const MIN_MUSIC_SECONDS = 50;
/** 判定为「响」的 RMS 阈值 */
export const LOUD_RMS = 0.06;
/** 判定为「稳」的方差上限（RMS 的标准差） */
export const STABLE_STD = 0.035;
/** 片头候选的搜索范围：前 20% */
export const OPENING_ZONE = 0.2;
/** 片尾候选的搜索范围：后 25% */
export const ENDING_ZONE = 0.25;

/** 一段「又响又稳又长」的音乐段 */
export interface MusicSpan {
  start: number;
  end: number;
  mean: number;
  std: number;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}

/**
 * 在音量曲线里找音乐段。
 *
 * 做法：滑动窗口逐点判定「响 + 稳」，把连续满足的点并成段，
 * 再丢掉太短的段。窗口内至少要有 3 个采样点，否则噪声会伪装成音乐段。
 */
export function findMusicSpans(
  samples: VolumeSample[],
  opts: { minSeconds?: number; loudRms?: number; stableStd?: number } = {}
): MusicSpan[] {
  const minSeconds = opts.minSeconds ?? MIN_MUSIC_SECONDS;
  const loudRms = opts.loudRms ?? LOUD_RMS;
  const stableStd = opts.stableStd ?? STABLE_STD;
  if (samples.length < 4) return [];

  // 按时间排序，去掉重复时刻
  const sorted = samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.rms))
    .sort((a, b) => a.t - b.t);

  const spans: MusicSpan[] = [];
  let cur: VolumeSample[] = [];

  const flush = () => {
    if (cur.length >= 3) {
      const rms = cur.map((s) => s.rms);
      const m = mean(rms);
      const sd = std(rms, m);
      const dur = cur[cur.length - 1].t - cur[0].t;
      // ★ 时长用「首尾采样跨度」而不是 cur.length × 间隔：
      //   采样间隔不均匀（卡顿时会漏采），按数量算会把停顿也算进音乐里。
      if (dur >= minSeconds && m >= loudRms && sd <= stableStd) {
        spans.push({ start: cur[0].t, end: cur[cur.length - 1].t, mean: m, std: sd });
      }
    }
    cur = [];
  };

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    // 以当前点结尾、往前取 1.2 秒的窗口来判定「响且稳」
    const win = [s];
    for (let j = i - 1; j >= 0 && s.t - sorted[j].t <= 1.2; j--) win.unshift(sorted[j]);
    if (win.length >= 3) {
      const rms = win.map((x) => x.rms);
      const m = mean(rms);
      if (m >= loudRms && std(rms, m) <= stableStd) {
        // ★ 新段起点要取**窗口最早的点**，不是当前点：
        //   判定需要「往前 1.2 秒都响且稳」，所以音乐真正的第一个点
        //   会比第一个满足判定的点早约 1 秒。不回溯的话 start 会晚一拍，
        //   跳过时就漏掉 OP 的第一秒。
        if (cur.length === 0) cur = win.slice();
        else cur.push(s);
        continue;
      }
    }
    flush();
  }
  flush();

  return mergeAdjacent(spans, 2);
}

/** 合并间隔很近的段（OP 里偶尔的过场不该把它切成两半） */
function mergeAdjacent(spans: MusicSpan[], gapSeconds: number): MusicSpan[] {
  if (spans.length < 2) return spans;
  const out: MusicSpan[] = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const last = out[out.length - 1];
    if (spans[i].start - last.end <= gapSeconds) {
      last.end = spans[i].end;
      last.mean = (last.mean + spans[i].mean) / 2;
      last.std = Math.max(last.std, spans[i].std);
    } else {
      out.push(spans[i]);
    }
  }
  return out;
}

/**
 * 把音乐段转成片头/片尾候选。
 *
 * 只取每个区域里**最长**的一段：OP/ED 通常是该区域里最长的稳定音乐段，
 * 短的多半是插曲。取最长比取第一段稳。
 */
export function proposeSkipSegments(
  samples: VolumeSample[],
  duration: number
): SkipSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const spans = findMusicSpans(samples);
  if (!spans.length) return [];

  const out: SkipSegment[] = [];
  const openingCut = duration * OPENING_ZONE;
  const endingCut = duration * (1 - ENDING_ZONE);

  // ★ 按时长降序取最长。比较器必须是「b 的时长 - a 的时长」——
  //   曾经写成 `b.end - b.start`，那只是 b **自己**的时长，
  //   不是两者的差，排序结果取决于单元素数值而不是相对大小，
  //   长片头反而排到短插曲后面（debug 实测：sortedDurations = [50.5, 80.25]）。
  const byDurationDesc = (a: MusicSpan, b: MusicSpan) =>
    b.end - b.start - (a.end - a.start);
  const opening = spans.filter((s) => s.end <= openingCut).sort(byDurationDesc)[0];
  const ending = spans.filter((s) => s.start >= endingCut).sort(byDurationDesc)[0];

  // 片尾只取音乐段的后 80%：ED 的最后一秒常常是staff表/预告，跳过整段更符合直觉
  if (opening) {
    out.push({ type: 'opening', start: Math.round(opening.start), end: Math.round(opening.end) });
  }
  if (ending) {
    const from = ending.start + (ending.end - ending.start) * 0.8;
    out.push({ type: 'ending', start: Math.round(from), end: Math.round(ending.end) });
  }
  return out;
}

/** 供 UI 展示的一句话摘要（确认弹窗用） */
export function describeSegments(segs: SkipSegment[]): string {
  if (!segs.length) return '未检测到片头片尾';
  const fmt = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  return segs
    .map((s) => `${s.type === 'opening' ? '片头' : s.type === 'ending' ? '片尾' : '中段'} ${fmt(s.start)} - ${fmt(s.end)}`)
    .join('　');
}
