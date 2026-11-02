'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { VideoEnhancer, LEVELS, LEVEL_GROUPS, type EnhanceLevel } from '@/lib/video-enhancer';
import { useCurrentVideo } from '@/lib/current-video';
import { Icon } from './icon';

/**
 * 超分辨率开关
 *
 * 挂在播放器控制栏，对**所有片源生效** —— 增强发生在解码之后的渲染环节，
 * 与片源来自哪个站、走哪条线路完全无关。换源、换集、切 IPTV 直播都不用重开。
 *
 * 三档强度对应 LEVELS 里的参数；关闭时把 video 的 opacity 复原即可，
 * 不销毁 ArtPlayer，所以进度、音量、全屏、PIP 全部不受影响。
 */
export function EnhanceControl({
  video: videoProp,
  className,
  open: controlledOpen,
  onOpenChange,
  menuSide = 'up',
  level: controlledLevel,
  onLevelChange,
  alwaysMounted,
}: {
  /** 可选：显式指定 video 元素。省略时用全局注册的「当前播放中的 video」。 */
  video?: HTMLVideoElement | null;
  className?: string;
  /** 受控开合：外部（如播放器控制栏按钮）驱动时传这个 */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  /** 菜单弹出方向：up=向上（页头用），down=向下（播放器控制栏用） */
  menuSide?: 'up' | 'down';
  /**
   * 受控档位：控制栏按钮循环切档时由外部驱动。
   * ★ 必须支持受控，否则控制栏切了档、组件内部状态却不知道，
   *   VideoEnhancer 收不到 setLevel → 「点了没反应」的另一种形式。
   */
  level?: EnhanceLevel;
  onLevelChange?: (l: EnhanceLevel) => void;
  /**
   * 引擎常驻：菜单收起时组件仍在（`alwaysMounted` 时用 CSS 隐藏而非卸载）。
   * 卸载会把 VideoEnhancer 一起 dispose，canvas 撤掉、画面回到原片 ——
   * 全屏时菜单被移出可视区就等于关掉增强，所以必须常驻。
   */
  alwaysMounted?: boolean;
}) {
  // 全局 video：播放器挂载时会把 <video> 注册进来
  const globalVideo = useCurrentVideo();
  const [innerLevel, setInnerLevel] = useState<EnhanceLevel>('off');
  const level = controlledLevel ?? innerLevel;
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  // 支持 setOpen(true/false) 和 setOpen(prev => !prev) 两种写法
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(open) : v;
    setInnerOpen(next);
    onOpenChange?.(next);
  };
  const [support, setSupport] = useState<boolean | null>(null); // null = 尚未检测
  const [justApplied, setJustApplied] = useState<EnhanceLevel | null>(null);
  const [comparing, setComparing] = useState(false);
  // 输出分辨率：判断增强有没有真跑起来的硬证据
  const [outSize, setOutSize] = useState<{ w: number; h: number; sourceW: number; sourceH: number } | null>(null);
  const [supportInfo, setSupportInfo] = useState<{ renderer?: string; precision?: string } | null>(null);
  const [lowFps, setLowFps] = useState<number | null>(null);
  const [anime4kError, setAnime4kError] = useState<string | null>(null);
  const enhancerRef = useRef<VideoEnhancer | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /**
   * ★ video 必须存进 state，不能在渲染时直接读 ref。
   *
   * 踩过的坑：原来写的是
   *     const video = videoRef?.current ?? globalVideo;
   *     useEffect(() => { ...new VideoEnhancer(video) }, [videoRef]);
   * ① 渲染时 `videoRef.current` 还是 null（ArtPlayer 还没创建 video）；
   * ② 依赖传的 `[videoRef]` 是 ref **对象**，引用永远不变 → effect 永不重跑。
   * 结果 VideoEnhancer 从没被创建，点任何档位都是可选链短路 → 画面毫无变化。
   *
   * 现在：播放器拿到 video 后 setState，这里跟着重新初始化。
   */
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    setVideo(videoProp ?? globalVideo);
  }, [videoProp, globalVideo]);

  /**
   * ★ 兜底：直接从 DOM 里找 <video>，找不到就轮询，直到找到为止。
   *
   * 这是「点了没反应」的最后一道保险。
   * 播放器把 <video> 挂到 DOM 的时机是不确定的：
   *   - ArtPlayer 构造完那一瞬 `art.video` 还是 undefined（DOM 下一 tick 才建好）
   *   - 通过 prop / 全局注册表传递都可能错过时机
   * 结果就是 VideoEnhancer 永远创建不出来 → 点任何档位都毫无反应。
   *
   * 但只要页面上存在 <video>，就说明播放器已经就绪 —— 直接用它最稳。
   * 找到后立刻停止轮询。
   */
  useEffect(() => {
    let timer = 0;
    const tryFind = (): boolean => {
      const v = document.querySelector('video') as HTMLVideoElement | null;
      if (!v) return false;
      setVideo(v);
      if (timer) {
        window.clearInterval(timer);
        timer = 0;
      }
      return true;
    };
    if (!tryFind()) {
      timer = window.setInterval(tryFind, 400);
    }
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, []);

  // video 还没出现时先不建 GL 上下文（等它出现）
  useEffect(() => {
    const v = video;
    if (!v) return;
    const inst = new VideoEnhancer(v);
    // 掉帧只提示、不自动降档：画面突然变弱比掉帧更让人烦躁
    inst.onLowFps = fps => setLowFps(fps);
    enhancerRef.current = inst;
    const info = inst.init();
    setSupport(info.supported);
    setSupportInfo({ renderer: info.renderer, precision: info.precision });
    if (info.anime4k === false && info.anime4kError) setAnime4kError(info.anime4kError);
    return () => {
      inst.dispose();
      enhancerRef.current = null;
    };
  }, [video]);

  // 采样输出分辨率（增强档位变化时 canvas 尺寸会变）
  useEffect(() => {
    const t = window.setInterval(() => {
      const inst = enhancerRef.current;
      if (!inst) return;
      const sz = inst.outputSize;
      setOutSize((prev) =>
        prev && prev.w === sz.w && prev.h === sz.h && prev.sourceW === sz.sourceW
          ? prev
          : sz
      );
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const apply = useCallback((next: EnhanceLevel) => {
    setInnerLevel(next);
    onLevelChange?.(next);
    setJustApplied(next);
    // 3 秒后清掉「刚应用」的提示
    window.setTimeout(() => setJustApplied((cur) => (cur === next ? null : cur)), 3000);
    setLowFps(null);
    setAnime4kError(null);
    enhancerRef.current?.setLevel(next);
    try {
      // 记住选择，下次打开页面自动沿用
      localStorage.setItem('libretv:enhance', next);
    } catch { /* 隐私模式下写不了，忽略 */ }
  }, [onLevelChange]);

  // 受控档位变化 → 真正应用到 VideoEnhancer（控制栏切档走这条路径）
  useEffect(() => {
    if (controlledLevel === undefined) return;
    if (enhancerRef.current && innerLevel !== controlledLevel) {
      enhancerRef.current.setLevel(controlledLevel);
    }
    setInnerLevel(controlledLevel);
  }, [controlledLevel, innerLevel]);

  // 首次挂载时恢复上次的档位
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('libretv:enhance'); } catch { /* ignore */ }
    if (saved && saved in LEVELS || saved === 'off') {
      // 等 GL 初始化完成再套用
      const t = setTimeout(() => apply(saved as EnhanceLevel), 60);
      return () => clearTimeout(t);
    }
  }, [apply, video]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const unsupported = support === false;
  const glInfo = support === false ? '未检测到' : (supportInfo?.renderer || '已就绪');

  return (
    <div ref={rootRef} className={cn('relative flex items-center', className)}>
      <button
        type="button"
        className={cn(
          'art-control gap-1',
          unsupported
            ? 'text-warning'
            : level !== 'off' && 'text-accent border-accent/40'
        )}
        onClick={() => setOpen(o => !o)}
        title={
          unsupported
            ? '当前环境不支持 WebGL，无法启用增强（点开查看原因）'
            : level === 'off'
              ? '超分辨率：提升低清片源的观感清晰度'
              : `超分辨率已开启（${LEVELS[level as Exclude<EnhanceLevel, 'off'>].label}）`
        }
        aria-label="超分辨率设置"
        aria-expanded={open}
      >
        <Icon name="sparkles" />
        {/* ★ 常显文字：只留一个 ✨ 图标太隐蔽，用户根本找不到这个功能（反馈过）。
            关闭时显示「超分」，开启后显示当前档位名，一眼就知道状态。 */}
        <span className="text-[11px] leading-none">
          {level === 'off' ? '超分' : LEVELS[level as Exclude<EnhanceLevel, 'off'>].label}
        </span>
      </button>

      {(open || alwaysMounted) && (
        <div
          style={!open ? { display: 'none' } : undefined}
          className={cn(
            'absolute right-0 z-50 w-60 rounded-lg border border-line bg-panel p-1 shadow-xl',
            menuSide === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
            // 菜单比播放器还高时不能溢出被裁：限高 + 内部滚动
            'max-h-[min(420px,70vh)] overflow-y-auto overscroll-contain'
          )}
        >
          {/* ★ 诊断信息：之前失败时界面上什么都不显示（按钮还被 CSS 隐藏了），
              用户只看到「点了没反应」。这里把 WebGL 状态直接摊开。 */}
          <div
            className={cn(
              'mb-1 rounded px-2 py-1.5 text-[10px] leading-relaxed',
              unsupported ? 'bg-warning/10 text-warning' : 'bg-chip/60 text-faint'
            )}
          >
            {support === null ? (
              <>正在检测 WebGL…</>
            ) : unsupported ? (
              <>
                <strong>WebGL 不可用</strong>，无法启用增强。
                <br />
                常见原因：无显卡驱动 / 浏览器禁用了硬件加速 / 远程桌面。
                <br />
                可试：Edge 浏览器 → 设置 → 系统和性能 → 打开「使用图形加速」。
              </>
            ) : (
              <>
                WebGL <strong>已就绪</strong>
                {supportInfo?.precision ? `（${supportInfo.precision}）` : ''}
                {supportInfo?.renderer ? ` · ${supportInfo.renderer.slice(0, 42)}` : ''}
              </>
            )}
          </div>

          {/* ★ 分辨率对照：一眼看出增强有没有真跑。
              Anime4K 档下输出应是原片的 2×（1080p → 3840×2160 = 4K）。 */}
          {outSize && outSize.w > 0 && (
            <div className="mb-1 rounded bg-chip/60 px-2 py-1.5 text-[10px] leading-relaxed text-faint">
              原片 <span className="text-muted">{outSize.sourceW}×{outSize.sourceH}</span>
              {' → '}
              输出 <span className={outSize.w > outSize.sourceW ? 'text-accent' : 'text-muted'}>{outSize.w}×{outSize.h}</span>
              {outSize.w > outSize.sourceW ? (
                <span className="ml-1 text-accent">
                  （{outSize.w / Math.max(1, outSize.sourceW)}× 放大
                  {outSize.w >= 3800 ? ' · 4K' : ''}）
                </span>
              ) : (
                <span className="ml-1">（未放大）</span>
              )}
            </div>
          )}

          {level !== 'off' && (
            <div className="mb-1 flex items-center gap-1.5 rounded bg-accent/10 px-2 py-1.5 text-[10px] text-accent">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              {comparing ? '正在显示原画…' : `当前生效：${LEVELS[level as Exclude<EnhanceLevel, 'off'>].label}`}
              {!comparing && justApplied === level && <span className="text-faint">（已应用）</span>}
            </div>
          )}

          <MenuItem active={level === 'off'} onClick={() => { apply('off'); setOpen(false); }}>
            关闭
          </MenuItem>

          {/* ★ 按住对比：增强效果本来就微妙（效率档只是微调），
              肉眼很难判断有没有生效。给一个「按住看原画 / 松开看增强」的直接对比。 */}
          {level !== 'off' && (
            <button
              type="button"
              className="w-full rounded px-2 py-1.5 text-left text-xs text-muted transition-colors hover:bg-chip"
              onPointerDown={() => {
                // 临时关掉增强，松手恢复
                enhancerRef.current?.setLevel('off');
                setComparing(true);
              }}
              onPointerUp={() => {
                enhancerRef.current?.setLevel(level);
                setComparing(false);
              }}
              onPointerLeave={() => {
                if (!comparing) return;
                enhancerRef.current?.setLevel(level);
                setComparing(false);
              }}
            >
              按住查看原画
              <span className="ml-1 text-[10px] text-faint">松开恢复增强</span>
            </button>
          )}

          {/* ★ 按「效率档 / 质量档」分组（用户要求）：
              效率档 = 原生分辨率 + 轻量着色器，几乎不卡
              质量档 = Anime4K 真·CNN 超分，2× 放大，最吃 GPU */}
          {LEVEL_GROUPS.map((grp, gi) => (
            <div key={grp.key} className={cn(gi > 0 && 'mt-1 border-t border-line pt-1')}>
              <div className="px-2 pt-1 pb-0.5">
                <div className="text-[10px] font-medium text-muted">{grp.title}</div>
                <div className="text-[9px] leading-tight text-faint">{grp.hint}</div>
              </div>
              {(Object.keys(LEVELS) as (keyof typeof LEVELS)[])
                .filter(k => LEVELS[k].group === grp.key)
                .map(k => (
                  <MenuItem
                    key={k}
                    active={level === k}
                    disabled={unsupported}
                    onClick={() => { apply(k); setOpen(false); }}
                  >
                    {LEVELS[k].label}
                    <span className="ml-1 text-[10px] text-faint">{LEVELS[k].desc}</span>
                  </MenuItem>
                ))}
            </div>
          ))}

          {unsupported && (
            <div className="mt-1 border-t border-line px-2 py-1.5 text-[10px] leading-relaxed text-warning">
              当前环境无法启用增强，换用浏览器或开启硬件加速后再试。
            </div>
          )}
          {anime4kError && (
            <div className="mt-1 border-t border-line px-2 py-1.5 text-[10px] leading-relaxed text-warning">
              Anime4K 不可用：{anime4kError}
            </div>
          )}
          {lowFps !== null && (
            <div className="mt-1 border-t border-line px-2 py-1.5 text-[10px] leading-relaxed text-warning">
              检测到约 {lowFps} FPS，若播放卡顿可切到「轻度」或关闭
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full rounded px-2 py-1.5 text-left text-xs transition-colors',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
        !disabled && (active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-chip')
      )}
    >
      {children}
    </button>
  );
}