'use client';

import { useEffect, useState } from 'react';

interface LibreTVBridge {
  isDesktop?: boolean;
  windowAction?: (a: 'min' | 'max' | 'close') => void;
  isMaximized?: () => Promise<boolean>;
  onMaximizeChange?: (cb: (v: boolean) => void) => () => void;
}

/**
 * 桌面版顶栏
 *
 * Electron 用 `titleBarStyle: 'hidden'` 隐藏了系统标题栏，
 * 这样可以去掉 Windows 11 那条扎眼的白色边框，也省出垂直空间。
 * 代价是：窗口失去拖拽区，最小化/最大化/关闭按钮也没了。
 *
 * 这个组件补上这两块：
 *   · 左侧 = 拖拽区（`-webkit-app-region: drag`）
 *   · 右侧 = 窗口控制（`no-drag` 才能点击）
 *
 * ★ 关键：顶栏 fixed 覆盖在内容上，**必须让下面的内容下移**，否则会挡住。
 *   之前只加顶栏没加偏移，用户反馈「横条把一些东西挡住了」（页头的 logo + 搜索框）。
 *   现在三处配合：
 *     · 顶栏 fixed top-0 z-60
 *     · --titlebar-h = 36px 写进 html 行内样式
 *     · body 加 padding-top: var(--titlebar-h)，页头 sticky top 也用这个变量
 *   网页版 --titlebar-h 保持默认 0px，一切照旧。
 */
export function DesktopTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const api = (window as unknown as { libretv?: LibreTVBridge }).libretv;
    if (!api?.isDesktop) return;
    setIsDesktop(true);
    void api.isMaximized?.().then(setMaximized);
    return api.onMaximizeChange?.(setMaximized);
  }, []);

  // 桌面版：给根元素加 --titlebar-h，下面的 sticky 页头据此下移
  useEffect(() => {
    if (!isDesktop) return;
    const root = document.documentElement;
    root.style.setProperty('--titlebar-h', '36px');
    root.classList.add('is-desktop');
    return () => {
      root.style.removeProperty('--titlebar-h');
      root.classList.remove('is-desktop');
    };
  }, [isDesktop]);

  if (!isDesktop) return null;

  const send = (action: 'min' | 'max' | 'close') => {
    (window as unknown as { libretv?: LibreTVBridge }).libretv?.windowAction?.(action);
  };

  const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  return (
    <div
      className="fixed left-0 right-0 top-0 z-[60] flex h-9 select-none items-center border-b border-white/5"
      style={{ ...drag, background: 'rgb(11 16 26)' }}
    >
      {/* 左：logo + 标题（其余为拖拽区） */}
      <div className="flex h-full flex-1 items-center">
        <span
          className="ml-3 flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold text-white"
          style={{ ...noDrag, background: 'rgb(var(--c-accent))' }}
        >
          TV
        </span>
        <span className="ml-2 text-xs text-faint">LibreTV 影视工作台</span>
      </div>

      {/* 右：窗口控制 */}
      <div className="flex h-full" style={noDrag}>
        <button
          type="button"
          onClick={() => send('min')}
          title="最小化"
          aria-label="最小化"
          className="flex h-9 w-11 items-center justify-center text-muted transition-colors hover:bg-white/10 hover:text-content"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => send('max')}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          className="flex h-9 w-11 items-center justify-center text-muted transition-colors hover:bg-white/10 hover:text-content"
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
              <path d="M2.5 2.5V0.5h7v7H7.5" fill="none" stroke="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={() => send('close')}
          title="关闭"
          aria-label="关闭"
          className="flex h-9 w-11 items-center justify-center text-muted transition-colors hover:bg-danger hover:text-white"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}