import { db, type CachedMediaPlaylist, type PlaylistCacheEntry } from './db';
import {
  parseM3u8Playlist,
  parsePlaylistText,
  pickVariant,
  type ParsedPlaylist,
  type ParsedVariant,
} from './m3u8-parse';
import { documentBaseURI, makeAbsolute, stripAdGroups } from './m3u8';

/**
 * m3u8 解析结果缓存（缺口③：换集/重播时不再重复拉清单）。
 *
 * 缓存内容是「分片 URL 列表 + 每片时长」，按 `m3u8Url + episodeKey` 分组：
 * 同一集换一个源站地址就是另一份缓存，避免串档。
 *
 * 为什么缓存的是**解析结果**而不是清单原文：
 *   原文还要再解析一次（master 选档 + 相对地址绝对化），
 *   解析结果可以直接喂给预取器做分片定位与窗口计算，命中即省一次网络往返。
 *
 * 存储分两层：
 *   ① 内存 Map（同步命中，播放页热路径走这里）；
 *   ② IndexedDB（跨会话持久化，重开应用仍能命中）。
 * IndexedDB 不可用（隐私模式/配额满）时自动降级为「只有内存层」，
 * 行为退化成「本次会话内命中」，不影响播放。
 */

/** 清单缓存有效期：超过后重新拉取（直播源/短时效地址会被自动淘汰） */
export const PLAYLIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 内存层容量上限（超出按写入顺序淘汰最旧的） */
const MEMORY_CACHE_LIMIT = 32;

export type { CachedMediaPlaylist, PlaylistCacheEntry };

/** 缓存 key：清单地址 + 剧集标识 */
export function buildPlaylistCacheKey(m3u8Url: string, episodeKey: string): string {
  return `${m3u8Url}::${episodeKey}`;
}

/** 纯函数：判断缓存条目是否仍在有效期内 */
export function isPlaylistCacheFresh(
  entry: { createdAt?: number } | null | undefined,
  now: number,
  ttlMs: number = PLAYLIST_CACHE_TTL_MS
): boolean {
  if (!entry) return false;
  const createdAt = entry.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return false;
  const age = now - createdAt;
  // age < 0 说明条目来自「未来」（时钟被调过），按过期处理更安全
  return age >= 0 && age < ttlMs;
}

const memory = new Map<string, PlaylistCacheEntry>();

function memoryPut(entry: PlaylistCacheEntry): void {
  memory.delete(entry.key);
  memory.set(entry.key, entry);
  while (memory.size > MEMORY_CACHE_LIMIT) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
}

/** 读缓存条目：先内存层后 IndexedDB；任何异常都退化为「未命中」 */
export async function readPlaylistEntry(key: string): Promise<PlaylistCacheEntry | null> {
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const entry = await db.playlistCache.get(key);
    if (entry) memoryPut(entry);
    return entry ?? null;
  } catch {
    return null;
  }
}

/** 写缓存条目：内存层必写，IndexedDB 失败不影响播放 */
export async function writePlaylistEntry(entry: PlaylistCacheEntry): Promise<void> {
  memoryPut(entry);
  try {
    await db.playlistCache.put(entry);
  } catch {
    /* 存储不可用：只保留内存层 */
  }
}

/** ParsedPlaylist → 缓存用的 media 片段 */
export function toCachedMedia(playlist: ParsedPlaylist): CachedMediaPlaylist {
  return {
    segments: playlist.segments.map((s) => ({ url: s.url, duration: s.duration })),
    totalDuration: playlist.totalDuration,
    mediaSequence: playlist.mediaSequence,
    byterange: playlist.byterange,
    aesConf: playlist.aesConf ? { ...playlist.aesConf } : undefined,
  };
}

/** 缓存里的 media 片段 → ParsedPlaylist */
export function fromCachedMedia(
  media: CachedMediaPlaylist,
  variants?: ParsedVariant[]
): ParsedPlaylist {
  return {
    variants,
    segments: media.segments.map((s) => ({ url: s.url, duration: s.duration })),
    aesConf: media.aesConf,
    byterange: media.byterange,
    totalDuration: media.totalDuration,
    mediaSequence: media.mediaSequence,
  };
}

/**
 * 把一个 media 清单的解析结果写进缓存（同一档位重复写入时覆盖）。
 * lastMediaUrl 记录最近使用的档位：下次进入本集时优先用它预热。
 */
export async function cacheMediaPlaylist(
  m3u8Url: string,
  episodeKey: string,
  mediaUrl: string,
  playlist: ParsedPlaylist
): Promise<void> {
  const key = buildPlaylistCacheKey(m3u8Url, episodeKey);
  const existing = await readPlaylistEntry(key);
  const entry: PlaylistCacheEntry = {
    key,
    m3u8Url,
    episodeKey,
    variants: playlist.variants ?? existing?.variants,
    media: { ...(existing?.media ?? {}), [mediaUrl]: toCachedMedia(playlist) },
    lastMediaUrl: mediaUrl,
    createdAt: Date.now(),
  };
  await writePlaylistEntry(entry);
}

export interface PlaylistRequest {
  /** 本集清单地址（直连或代理改写形式） */
  m3u8Url: string;
  episodeKey: string;
  /** 指定要用的 media 清单地址（hls.js 当前档位）；缺省时按 master 选档 */
  mediaUrl?: string;
  /** 首选码率：与 hls.js 当前档位对齐 */
  preferredBitrate?: number;
  preferredHeight?: number;
  /** 是否剔除广告段（须与播放器的广告过滤开关一致） */
  stripLeadAd?: boolean;
}

/** 直接拉取并解析一个 media 清单 */
async function fetchMediaPlaylist(url: string, stripLeadAd?: boolean): Promise<ParsedPlaylist> {
  const base = makeAbsolute(url, documentBaseURI());
  const res = await fetch(base, { headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error(`m3u8 拉取失败：HTTP ${res.status}`);
  const raw = await res.text();
  const text = stripLeadAd === false ? raw : stripAdGroups(raw);
  return parsePlaylistText(text, base, 0, undefined, { stripLeadAd: true });
}

/**
 * 取播放列表：命中缓存则零网络往返，否则拉取并写入缓存。
 *
 * 命中策略：
 *   - 给了 mediaUrl（当前档位）：该档位解析过就直接复用；
 *   - 没给：按 master 档位表选档（优先码率对齐），该档位解析过就复用。
 * 缓存过期时只重拉「需要的这一档」，master 档位表仍可复用。
 */
export async function getPlaylistWithCache(req: PlaylistRequest): Promise<ParsedPlaylist> {
  const key = buildPlaylistCacheKey(req.m3u8Url, req.episodeKey);
  const entry = await readPlaylistEntry(key);
  const fresh = isPlaylistCacheFresh(entry, Date.now());

  if (req.mediaUrl) {
    const media = fresh ? entry?.media?.[req.mediaUrl] : undefined;
    if (media) return fromCachedMedia(media, entry?.variants);
    const parsed = await fetchMediaPlaylist(req.mediaUrl, req.stripLeadAd);
    await cacheMediaPlaylist(req.m3u8Url, req.episodeKey, req.mediaUrl, parsed);
    return parsed;
  }

  if (fresh && entry?.variants?.length) {
    const chosen = pickVariant(entry.variants, req.preferredHeight, req.preferredBitrate);
    const media = entry.media?.[chosen.url];
    if (media) return fromCachedMedia(media, entry.variants);
    const parsed = await fetchMediaPlaylist(chosen.url, req.stripLeadAd);
    await cacheMediaPlaylist(req.m3u8Url, req.episodeKey, chosen.url, parsed);
    return parsed;
  }

  // 非 master 清单（单码率源）：清单地址本身就是 media 清单，缓存里按同一地址取
  const absolute = makeAbsolute(req.m3u8Url, documentBaseURI());
  const direct = fresh ? entry?.media?.[absolute] : undefined;
  if (direct) return fromCachedMedia(direct, entry?.variants);

  const parsed = await parseM3u8Playlist(req.m3u8Url, 0, req.preferredHeight, {
    stripLeadAd: req.stripLeadAd,
    preferredBitrate: req.preferredBitrate,
  });
  const mediaUrl = parsed.mediaUrl ?? req.m3u8Url;
  await cacheMediaPlaylist(req.m3u8Url, req.episodeKey, mediaUrl, parsed);
  return parsed;
}

/** 清空清单缓存（清缓存按钮会调用） */
export async function clearPlaylistCache(): Promise<void> {
  memory.clear();
  try {
    await db.playlistCache.clear();
  } catch {
    /* 忽略 */
  }
}
