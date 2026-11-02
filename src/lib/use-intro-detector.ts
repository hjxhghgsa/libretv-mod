/**
 * 片头片尾自动检测：采样与调度。
 *
 * 分两层：
 *   · 纯函数在 `intro-detector.ts`（音量曲线 → 候选片段），可单测；
 *   · 这里负责**采到曲线**：把 <video> 接进 Web Audio，用 AnalyserNode 读 RMS，
 *     以及「采够了就分析、弹确认」的调度。
 *
 * ## 为什么用 AnalyserNode 而不是解码音频
 * AnalyserNode 只读 FFT 结果，不额外解码、不复制数据，开销可以忽略。
 * 视频本身已经在解码了，音频数据只是顺路流过来。
 *
 * ## 关键约束
 *   · AudioContext 需要用户手势后才能 resume —— 播放天然就是手势，但**自动播放**
 *     （连播下一集）时可能没手势，此时拿不到 AudioContext，直接放弃检测不报错。
 *   · 只在前 20% + 后 25% 需要判定，所以**不需要采完整集**：
 *     采到 35% 就够（片头在前 20%，片尾在后 25%，中间的采样没有判定价值），
 *     提前停掉省 CPU。
 *   · 结果**只作为候选**，必须弹给用户确认，绝不静默跳过（见 intro-detector.ts 顶部说明）。
 */

import { useEffect, useRef } from 'react';
import { proposeSkipSegments, type VolumeSample } from './intro-detector';
import type { SkipSegment } from './skip-marks';

/** 采样间隔（毫秒）：4 次/秒足够刻画响度轮廓，开销可忽略 */
const SAMPLE_INTERVAL_MS = 250;
/** 采到全片这个比例就停：前 20%（片头）+ 后 25%（片尾）都能覆盖到 */
const SAMPLE_UNTIL_RATIO = 0.35;
/** 至少采到多少秒才分析（太短的片子没有 OP/ED） */
const MIN_SAMPLE_SECONDS = 60;

export interface IntroDetectorOptions {
  video: HTMLVideoElement | null;
  /** 本集总时长（秒）；0/NaN 表示未知，此时不检测 */
  duration: number;
  /** 是否启用（设置里的开关） */
  enabled: boolean;
  /** 本集是否已有标记（有就不重复检测，避免每次进来都弹） */
  alreadyMarked: boolean;
  /** 分析出候选后的回调（由调用方弹确认框） */
  onPropose: (segments: SkipSegment[]) => void;
}

/**
 * 在 video 上挂一个自动检测器。
 *
 * 生命周期跟随 video 元素：换集（video 重建）会自动重新开始，
 * 组件卸载时断开 AudioContext，不会泄漏。
 */
export function useIntroDetector(opts: IntroDetectorOptions): void {
  const { video, duration, enabled, alreadyMarked, onPropose } = opts;
  // 回调放 ref：调用方重渲染不会打断采样循环
  const onProposeRef = useRef(onPropose);
  onProposeRef.current = onPropose;
  // 只报一次：同一集内重复 timeupdate 不应该反复弹同一个框
  const reportedRef = useRef(false);

  useEffect(() => {
    reportedRef.current = false;
    if (!enabled || !video || alreadyMarked) return;
    if (!Number.isFinite(duration) || duration < MIN_SAMPLE_SECONDS) return;

    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let timer: number | undefined;
    const samples: VolumeSample[] = [];
    const stopUntil = duration * SAMPLE_UNTIL_RATIO;
    let disposed = false;

    const buf = new Float32Array(1024);

    const finish = () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      try { ctx?.close(); } catch { /* 忽略 */ }
      const segs = proposeSkipSegments(samples, duration);
      if (segs.length) onProposeRef.current(segs);
    };

    const start = () => {
      // 拿不到 AudioContext（无手势/被禁用）就安静退出，不影响播放
      try {
        const Ctor = window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        ctx = new Ctor();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0; // 关平滑：要的是原始起伏
        ctx.createMediaElementSource(video).connect(analyser);
        // ★ 必须同时接到 destination，否则视频原声音会被 Web Audio 链路吃掉
        analyser.connect(ctx.destination);
      } catch {
        return;
      }

      timer = window.setInterval(() => {
        if (disposed || !analyser) return;
        const t = video.currentTime;
        if (!Number.isFinite(t)) return;
        analyser.getFloatTimeDomainData(buf);
        // RMS：均方根，比峰值稳（峰值容易被单帧尖峰带偏）
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        samples.push({ t, rms });
        // 采够比例就停：片尾的判定需要后 25%，所以用 SAMPLE_UNTIL_RATIO 覆盖两端
        if (t >= stopUntil) finish();
      }, SAMPLE_INTERVAL_MS);
    };

    // 有些环境下 AudioContext 创建出来是 suspended，等用户真正开始播再采样
    const kick = () => {
      if (disposed) return;
      if (ctx && ctx.state === 'suspended') void ctx.resume();
    };
    video.addEventListener('playing', kick);

    start();
    kick();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      video.removeEventListener('playing', kick);
      try { ctx?.close(); } catch { /* 忽略 */ }
    };
  }, [video, duration, enabled, alreadyMarked]);
}
