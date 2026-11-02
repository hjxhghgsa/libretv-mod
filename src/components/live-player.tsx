'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';
import { Spinner } from './states';
import { registerVideo } from '@/lib/current-video';
import { EnhanceControl } from './enhance-control';
import { LEVELS, type EnhanceLevel } from '@/lib/video-enhancer';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import { ART_DEFAULT_CONTROL_HIDE_MS, TOUCH_CONTROL_HIDE_MS } from '@/lib/control-hide';

/**
 * 直播播放器：与点播 player-shell 完全独立。
 * - 引擎分发：.m3u8 → hls.js（直播参数）；.flv → mpegts.js（动态加载，按需 ~150KB）；
 *   mp4/webm 等原生容器 → <video> 直接播放；
 * - 无扩展名的地址（如 /channel/xxx?token=...）默认按 HLS 处理，
 *   HLS 直连与代理均失败后**回退原生播放**一次（覆盖"内容是 MP4 却无 .m3u8 后缀"的源）；
 * - 每级直连失败自动切换到 /api/live/stream 代理通道重试一次；
 * - 直播态 UI：无进度条、无倍速、无截图、无连播。
 */

/** 代理地址前缀（新旧形式 /api/live/stream/… 与 /api/live/stream?url=… 的共同前缀，用于防二次代理） */
const STREAM_PROXY_PREFIX = '/api/live/stream';
/** 代理地址（查询串形式：路径里的 %2F 会被 EdgeOne 等网关归一化，查询串不受影响） */
const STREAM_PROXY_BASE = '/api/live/stream?url=';

export function isFlvUrl(url: string): boolean {
  return /\.flv(\?|$)/i.test(url);
}

/** 浏览器原生可播的直链容器（非 HLS/FLV） */
const NATIVE_MEDIA_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|$)/i;

type Engine = 'hls' | 'flv' | 'native';

function engineOf(url: string): Engine {
  if (isFlvUrl(url)) return 'flv';
  if (NATIVE_MEDIA_RE.test(url)) return 'native';
  return 'hls';
}

function proxyUrl(url: string): string {
  return STREAM_PROXY_BASE + encodeURIComponent(url);
}

interface LivePlayerProps {
  /** 上游直播流地址（直连优先，失败自动走代理） */
  url: string;
  title: string;
  /** 上一台/下一台：传入时注册为播放器控制条按钮（全屏内也可操作） */
  onPrevChannel?: () => void;
  onNextChannel?: () => void;
}

export function LivePlayer({ url, title, onPrevChannel, onNextChannel }: LivePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mpegtsRef = useRef<any>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(true);
  // 手动重试计数：变化时重建整个播放器实例（比 location.reload() 轻得多）
  const [retryNonce, setRetryNonce] = useState(0);
  // 起播前的品牌占位图（与点播 player-shell 共用 /player-poster.png），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  // 换台 OSD：切台后短暂显示频道名（键盘换台/控制条换台时的视觉反馈，全屏内同样可见）
  const [osdTitle, setOsdTitle] = useState('');
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // url 变化即换台：显示频道名 2.5s
  useEffect(() => {
    if (!url) return;
    setOsdTitle(title);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsdTitle(''), 2500);
    return () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    };
  }, [url, title]);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  useEffect(() => {
    if (!containerRef.current || !url) return;
    setError('');
    setLoading(true);
    setShowPoster(true);

    let playbackStarted = false;
    let disposed = false;
    let destroyed = false;
    /** 原生播放注册的 error 监听清理函数（切台/销毁时调用） */
    let nativeCleanup: (() => void) | null = null;

    const cleanupEngines = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (mpegtsRef.current) {
        try { mpegtsRef.current.pause(); } catch { /* 忽略 */ }
        try { mpegtsRef.current.destroy(); } catch { /* 忽略 */ }
        mpegtsRef.current = null;
      }
      if (nativeCleanup) {
        try { nativeCleanup(); } catch { /* 忽略 */ }
        nativeCleanup = null;
      }
    };

    /**
     * 原生播放：mp4/webm 等容器交给 <video> 直接播放。
     * 也作为 HLS 两级都失败后的兜底——覆盖"地址没有 .m3u8 后缀但内容其实是 MP4"的源。
     * 直连失败（CORS/混合内容）时再走一次代理。
     */
    const setupNative = (
      video: HTMLVideoElement,
      mediaUrl: string,
      allowProxyFallback: boolean,
      failMessage?: string
    ) => {
      cleanupEngines();
      const onError = () => {
        video.removeEventListener('error', onError);
        nativeCleanup = null;
        if (disposed || destroyed) return;
        if (allowProxyFallback && !mediaUrl.startsWith(STREAM_PROXY_PREFIX)) {
          showHint('直连失败，改用代理重试...');
          setupNative(video, proxyUrl(url), false, failMessage);
          return;
        }
        setError(failMessage || '该地址不是可播放的直播流（内容可能是文件或错误提示）');
      };
      video.addEventListener('error', onError);
      nativeCleanup = () => video.removeEventListener('error', onError);
      video.src = mediaUrl;
      video.load();
      video.play().catch(() => {});
    };

    /** HLS 直播参数：小缓冲、快速追帧；与点播（大缓冲、进度恢复）刻意区分 */
    const setupHls = (video: HTMLVideoElement, mediaUrl: string, stage: 'direct' | 'proxy') => {
      cleanupEngines();
      let liveNetRetryCount = 0;
      let mediaRecoverCount = 0;
      const hlsConfig: Partial<HlsConfig> = {
        debug: false,
        enableWorker: true,
        liveSyncDurationCount: 3,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 4,
        fragLoadingRetryDelay: 800,
      };
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;
      hls.loadSource(mediaUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, manifestData) => {
        // H.265 检测：大量国内 IPTV 源为 HEVC 编码，Chromium 内核通常无法软解
        const videoCodecs = (manifestData.levels || []).map((l) => l.videoCodec || '').join(',');
        if (/hvc1|hev1|hevc/i.test(videoCodecs)) {
          const support = video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
          if (!support) {
            showHint('该频道为 H.265 编码，当前浏览器可能无法解码，建议用 Edge/Safari');
          }
        }
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (disposed || destroyed) return;
        const httpCode = data.response?.code;
        const codeHint = httpCode ? `（HTTP ${httpCode}）` : '';
        if (!data.fatal) return;
        // 媒体错误：起播前后统一尝试恢复，次数受限防止无限 recover 循环
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRecoverCount < 2) {
            mediaRecoverCount++;
            hls.recoverMediaError();
            return;
          }
          setError('直播流解码失败，可能该频道编码不受当前浏览器支持，请尝试其他频道');
          return;
        }
        if (!playbackStarted) {
          if (
            stage === 'direct' &&
            !mediaUrl.startsWith(STREAM_PROXY_PREFIX) &&
            (data.details === 'manifestLoadError' || data.type === Hls.ErrorTypes.NETWORK_ERROR)
          ) {
            showHint('直连失败，改用代理重试...');
            // 直播 manifest 重写需要本站前缀，交给代理通道
            setupHls(video, proxyUrl(url), 'proxy');
            return;
          }
          // HLS 直连与代理均失败：可能是"无 .m3u8 后缀但内容是 MP4"的源，回退原生播放
          showHint('HLS 解析失败，尝试原生播放...');
          setupNative(video, url, true, `直播流加载失败${codeHint}，可能该频道已失效，请尝试其他频道`);
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // 播放中网络抖动：尝试恢复拉流；连续失败达到阈值则报错退出
          liveNetRetryCount++;
          if (liveNetRetryCount > 5) {
            setError(`直播流中断${codeHint}，该源可能已失效，请尝试其他频道`);
            return;
          }
          hls.startLoad();
        }
      });
    };

    const setupFlv = async (
      video: HTMLVideoElement,
      mediaUrl: string,
      allowProxyFallback: boolean
    ) => {
      cleanupEngines();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let Mpegts: any;
      try {
        Mpegts = (await import('mpegts.js')).default;
      } catch {
        setError('FLV 播放模块加载失败，请检查网络后重试');
        return;
      }
      if (disposed || destroyed) return;
      if (!Mpegts.getFeatureList().mseLivePlayback) {
        setError('当前浏览器不支持 FLV 直播播放');
        return;
      }
      const player = Mpegts.createPlayer(
        {
          type: 'flv',
          isLive: true,
          url: mediaUrl,
        },
        {
          enableWorker: false,
          enableStashBuffer: false,
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          lazyLoad: false,
        }
      );
      mpegtsRef.current = player;
      player.attachMediaElement(video);
      player.load();
      player.on(Mpegts.Events.ERROR, (errType: string) => {
        if (disposed || destroyed) return;
        if (!playbackStarted && allowProxyFallback && !mediaUrl.startsWith(STREAM_PROXY_PREFIX)) {
          showHint('直连失败，改用代理重试...');
          void setupFlv(video, proxyUrl(url), false);
          return;
        }
        setError(`直播流加载失败（${errType}），请尝试其他频道`);
      });
      player.play().catch(() => {});
    };

    const engine = engineOf(url);
    // 上一台/下一台：注册到播放器控制条（普通态与全屏均可见），未传不显示
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controls: any[] = [];
    const channelBtnSvg = (path: string) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="${path}"/></svg>`;
    if (onPrevChannel) {
      controls.push({
        name: 'prev-channel',
        position: 'left',
        index: 0,
        html: channelBtnSvg('M11 19l-7-7 7-7m8 14l-7-7 7-7'),
        tooltip: '上一台',
        click: () => onPrevChannel(),
      });
    }
    if (onNextChannel) {
      controls.push({
        name: 'next-channel',
        position: 'left',
        index: 1,
        html: channelBtnSvg('M13 5l7 7-7 7M5 5l7 7-7 7'),
        tooltip: '下一台',
        click: () => onNextChannel(),
      });
    }
    // 超分辨率：控制栏文字按钮（与「倍速」并排），点击循环切档
    controls.push({
      name: 'enhance',
      position: 'right',
      index: 1,
      html: '<span class="enhance-btn-label" onmousedown="window.__ltvCompare&&window.__ltvCompare(1)" onmouseup="window.__ltvCompare&&window.__ltvCompare(0)" onmouseleave="window.__ltvCompare&&window.__ltvCompare(0)">超分率</span>',
      click: () => {
        setEnhanceOpen(true);
      },
    });

    // 触屏没有 hover，原生 3 秒自动隐藏会让直播控制栏（上一台/下一台）点不到
    // （issue #937）：触屏常驻、由点按视频 toggle 收起；桌面行为不变
    const touchPointer = prefersTouchPointer();
    if (touchPointer) Artplayer.CONTROL_HIDE_TIME = TOUCH_CONTROL_HIDE_MS;

    const art = new Artplayer({
      container: containerRef.current,
      url,
      // 原生容器统一用 'mp4'（仅用于选择处理函数，实际容器由浏览器嗅探）
      type: engine === 'flv' ? 'flv' : engine === 'native' ? 'mp4' : 'm3u8',
      volume: 0.9,
      autoplay: true,
      // —— 直播态：关闭点播专属能力 ——
      pip: true,
      screenshot: false,
      setting: false,
      playbackRate: false,
      aspectRatio: false,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: false,
      hotkey: false,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      theme: '#2563eb',
      controls,
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { playsInline: true },
      customType: {
        m3u8: (video: HTMLVideoElement) => {
          setupHls(video, url, 'direct');
        },
        flv: (video: HTMLVideoElement) => {
          void setupFlv(video, url, true);
        },
        mp4: (video: HTMLVideoElement) => {
          setupNative(video, url, true);
        },
      },
    });
    artRef.current = art;

    /**
     * ★ ArtPlayer 建好后把 <video> 交给增强器。
     *
     * 踩过的坑（用户反馈「点了没反应」的真凶）：
     *  ① 之前靠「另一个无依赖 effect 在下次渲染时补 setEnhanceVideo」，
     *     但 setEnhanceVideo(null) 值没变化 → React 不重渲染 → 那个 effect
     *     再也不跑 → VideoEnhancer 永远创建不出来。
     *  ② 改成 `if (art.video)` 也不行 —— **ArtPlayer 构造完的那一瞬，
     *     `art.video` 还是 undefined**（DOM 在下一个 tick 才建好），
     *     条件不成立 → 同样没交付。
     *
     * 现在改成**从 DOM 里查**，并在三个时机各试一次（立即 / 下一帧 / ready 事件），
     * 只要拿到就交付，拿不到就等下一次。
     */
    const grabVideo = () => {
      const v = (art.video as HTMLVideoElement | undefined)
        ?? (containerRef.current?.querySelector('video') as HTMLVideoElement | null);
      if (!v) return;
      setEnhanceVideo(v);
      registerVideo(v);
    };
    grabVideo();
    requestAnimationFrame(grabVideo);
    art.on('ready', grabVideo);
    art.on('video:loadedmetadata', () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = title;
      } catch { /* 忽略 */ }
    });
    art.on('video:playing', () => {
      playbackStarted = true;
      setLoading(false);
      setShowPoster(false);
      setError('');
    });
    art.on('video:error', () => {
      // mpegts 走自身 ERROR 事件；这里兜底其它未知错误
      if (!mpegtsRef.current) setError('视频播放失败，请尝试其他频道');
    });
    art.on('ready', () => {
      // 直播隐藏进度条（ArtPlayer 无原生 isLive 开关）
      try {
        const progress = art.controls?.progress as HTMLElement | undefined;
        if (progress) progress.style.display = 'none';
      } catch { /* 忽略 */ }
    });

    // 15s 内未起播则提示
    const startTimer = setTimeout(() => {
      if (!playbackStarted && !disposed && !destroyed) {
        setError('频道加载超时，可能该源已失效，请尝试其他频道');
      }
    }, 15000);

    return () => {
      disposed = true;
      clearTimeout(startTimer);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      cleanupEngines();
      art.destroy();
      artRef.current = null;
      // CONTROL_HIDE_TIME 是全局 static：恢复库默认值，避免影响后续挂载的其它播放器
      if (touchPointer) Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      destroyed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryNonce, onPrevChannel, onNextChannel]);

  // 把 ArtPlayer 内部的 <video> 注册到全局
  // ★ 必须用 state 而不是 ref：ref 变化不会触发子组件的 useEffect，
  //   EnhanceControl 会一直拿不到 video（它靠这个 state 来初始化 GL 上下文）。
  const [enhanceVideo, setEnhanceVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = artRef.current?.video ?? null;
    setEnhanceVideo(v);
    registerVideo(v);
  });
  useEffect(() => () => registerVideo(null), []);

  /**
   * 全屏时档位面板要跟着进全屏元素，否则会消失。
   * ★ 用 createPortal 而不是 appendChild 搬 DOM —— 后者会让 React 的 diff 失效。
   */
  useEffect(() => {
    const onFs = () => setFsHost(document.fullscreenElement as HTMLElement | null);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // 超分档位菜单开合：由控制栏按钮驱动
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const [enhanceLevel, setEnhanceLevel] = useState<EnhanceLevel>('off');
  // 全屏元素：档位面板要 portal 进去
  const [fsHost, setFsHost] = useState<HTMLElement | null>(null);
  /**
   * ★ portal 宿主必须用 state 拿，不能直接读 containerRef.current。
   *   首次渲染时 ref 还是 null → createPortal(node, null) 会让 React 抛
   *   error #299「Target container is not a DOM element」→ 整页崩溃。
   */
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  // 全屏时 portal 进全屏元素，否则挂在播放器容器里
  const portalTarget = fsHost ?? panelHost;

  /**
   * 更新控制栏按钮上的档位文字
   *
   * ★ ArtPlayer 的 controls 数组是**创建时一次性构建**的，
   *   里面的 click 闭包拿不到后续的 state（老值永远是首次渲染的值）。
   *   所以按钮文字必须手动改 DOM。
   */
  const syncEnhanceBtn = useCallback((level: EnhanceLevel) => {
    const el = containerRef.current?.querySelector('.art-control-enhance .enhance-btn-label');
    if (el) el.textContent = level === 'off' ? '超分率' : LEVELS[level].label;
  }, []);

  /** 长按对比原画（ArtPlayer 控件是 innerHTML，只能走 window 桥接） */
  useEffect(() => {
    const w = window as unknown as { __ltvCompare?: (on: number) => void };
    w.__ltvCompare = (on: number) => {
      const cvs = containerRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!cvs) return;
      cvs.style.visibility = on ? 'hidden' : '';
    };
    return () => { w.__ltvCompare = undefined; };
  });

  return (
    <div className="relative w-full h-full">
      <div
        ref={(el) => {
          containerRef.current = el;
          setPanelHost(el);
        }}
        className="w-full h-full"
      />
      {/* 超分档位面板：portal 到全屏元素，常驻挂载以保证增强器一直活着 */}
      {portalTarget && createPortal(
        <div
          className="pointer-events-none absolute inset-0 z-[70]"
          style={{ display: enhanceOpen ? 'block' : 'none' }}
        >
          <div className="absolute inset-0" onClick={() => setEnhanceOpen(false)} />
          <div className="pointer-events-auto absolute bottom-[46px] right-2">
            <EnhanceControl
              video={enhanceVideo}
              open={enhanceOpen}
              onOpenChange={setEnhanceOpen}
              menuSide="up"
              level={enhanceLevel}
              onLevelChange={(l) => { setEnhanceLevel(l); syncEnhanceBtn(l); }}
              alwaysMounted
              className="[&>button]:hidden"
            />
          </div>
        </div>,
        portalTarget
      )}
      {/* 起播前的品牌占位图 */}
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {/* LIVE 呼吸标识 */}
      {!error && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/60 px-2 py-1 rounded-full pointer-events-none">
          <span className="live-dot" />
          <span className="text-[10px] font-semibold text-white tracking-wider">LIVE</span>
        </div>
      )}
      {/* 换台 OSD：频道名（全屏内同样可见） */}
      {osdTitle && !error && (
        <div className="absolute top-3 left-3 flex items-center max-w-[70%] bg-black/60 px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          <span className="text-sm font-medium text-white truncate">{osdTitle}</span>
        </div>
      )}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
          <Spinner size="lg" tone="onDark" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm px-4 text-center">{error}</p>
          <button
            className="btn-ghost text-xs !bg-white/10 !text-white !border-white/20"
            onClick={() => {
              // 重建播放器实例即可，无需整页刷新
              setError('');
              setHint('');
              setRetryNonce((n) => n + 1);
            }}
          >
            重新加载
          </button>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
    </div>
  );
}
