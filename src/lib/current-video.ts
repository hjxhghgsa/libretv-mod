'use client';

import { useEffect, useState } from 'react';

/**
 * 全局「当前播放中的 <video>」追踪
 *
 * 背景：超分增强需要拿到真实的 <video> 元素才能把画面送进 WebGL。
 * 原来只有播放器组件自己持有 videoRef，于是「超分」按钮只能挂在播放器上 ——
 * 而播放器要等选源/选频道后才渲染，用户在搜索页、详情页根本看不到这个入口。
 *
 * 这里改成一个全局注册表：
 *   · 播放器挂载时把自己的 <video> 注册进来
 *   · 页头的超分按钮从这里取 video，两边解耦
 *
 * 用一个模块级的订阅表，任何页面都能用。
 */

type Listener = (video: HTMLVideoElement | null) => void;

const listeners = new Set<Listener>();
let current: HTMLVideoElement | null = null;

export function getCurrentVideo(): HTMLVideoElement | null {
  return current;
}

export function subscribeVideo(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

export function registerVideo(video: HTMLVideoElement | null) {
  if (current === video) return;
  current = video;
  for (const fn of listeners) fn(video);
}

/** React hook：订阅当前 video */
export function useCurrentVideo(): HTMLVideoElement | null {
  const [video, setVideo] = useState<HTMLVideoElement | null>(current);
  useEffect(() => subscribeVideo(setVideo), []);
  return video;
}
