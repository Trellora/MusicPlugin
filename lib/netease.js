/**
 * lib/netease.js —— 网易云音乐公开接口的 https 客户端（只经 context.network.fetch，零第三方依赖）。
 *
 * 范围（v0.1）：全部为**公开、无需登录**的只读接口：
 *   - 排行榜/歌单详情：https://music.163.com/api/playlist/detail?id=<id>&n=500
 *   - 歌曲搜索：      https://music.163.com/api/search/get/web?kw=<关键词>&type=1&limit=20
 *   - 歌词：          https://music.163.com/api/song/lyric?id=<id>&lv=1&kv=1&tv=-1
 * 登录态接口（每日推荐 / 我的歌单）只留函数签名，返回「v0.2 需要登录态」的可读错误，
 * **不实现 cookie 注入**、不绕过付费/DRM/地域限制。
 *
 * 错误语义：所有函数不抛裸异常，统一返回 { ok: true, data } 或 { ok: false, code, message }。
 */

'use strict';

/** 官方榜单 id 常量。 */
const OFFICIAL_CHART_IDS = Object.freeze({
  RISING: 19723756, // 飙升榜
  NEW: 3779629, // 新歌榜
  HOT: 3778678, // 热歌榜
  ORIGINAL: 2884035, // 原创榜
});

/** 榜单 id → 展示名。 */
const CHART_NAMES = Object.freeze({
  19723756: '飙升榜',
  3779629: '新歌榜',
  3778678: '热歌榜',
  2884035: '原创榜',
});

/** music.163.com 的接口要求 Referer / UA 请求头，否则可能返回空数据或拒绝。 */
const DEFAULT_HEADERS = Object.freeze({
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
});

/** 客户端侧兜底超时（毫秒）：即便宿主 fetch 未自带超时也保证不会永久悬挂。 */
const CLIENT_TIMEOUT_MS = 10_000;

const AUTH_REQUIRED_MESSAGE =
  'v0.2 需要登录态：该接口依赖网易云账号登录凭据，v0.1 不实现 cookie 注入与登录态管理，请等待 v0.2。';

// ── 纯函数：参数校验 / 响应归一 / 错误归一 ────────────────────────────────────

/** 榜单/歌曲 id 校验：正整数才合法。 */
function isPositiveInt(value) {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 把 playlist/detail 或 search 的歌曲条目归一为 { id, name, artists, album, durationMs }。
 * 兼容新旧字段名：artists/ar、album/al、duration/dt。
 */
function normalizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const artistsSource = track.artists ?? track.ar ?? [];
  const artists = (Array.isArray(artistsSource) ? artistsSource : [])
    .map((a) => (a && typeof a.name === 'string' ? a.name : typeof a === 'string' ? a : ''))
    .filter(Boolean);
  const albumSource = track.album ?? track.al ?? null;
  const album = albumSource && typeof albumSource === 'object' && typeof albumSource.name === 'string'
    ? albumSource.name
    : typeof albumSource === 'string' ? albumSource : '';
  const durationMs = Number.isFinite(track.duration) ? track.duration
    : Number.isFinite(track.dt) ? track.dt : 0;
  return {
    id: isPositiveInt(track.id),
    name: typeof track.name === 'string' ? track.name : '',
    artists,
    album,
    durationMs,
  };
}

/** 归一歌单详情响应 → { id, name, tracks: normalized[] }。 */
function normalizePlaylistPayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const playlist = body.result ?? body.playlist ?? null;
  if (!playlist || typeof playlist !== 'object') return null;
  const rawTracks = Array.isArray(playlist.tracks) ? playlist.tracks
    : Array.isArray(playlist.trackIds) ? playlist.trackIds : [];
  return {
    id: isPositiveInt(playlist.id),
    name: typeof playlist.name === 'string' ? playlist.name : '',
    tracks: rawTracks.map(normalizeTrack).filter(Boolean),
  };
}

/** 归一搜索响应 → { songs: normalized[] }。 */
function normalizeSearchPayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const result = body.result ?? body.songs ?? null;
  const rawSongs = result && Array.isArray(result.songs) ? result.songs
    : Array.isArray(result) ? result : [];
  return {
    songs: rawSongs.map(normalizeTrack).filter(Boolean),
  };
}

/** 归一歌词响应 → { lrc: string, translated: string }。 */
function normalizeLyricPayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const lrc = body.lrc && typeof body.lrc.lyric === 'string' ? body.lrc.lyric : '';
  const translated = body.tlyric && typeof body.tlyric.lyric === 'string' ? body.tlyric.lyric : '';
  return { lrc, translated };
}

/** 把任意异常归一为 { code, message }（中文可读，不含敏感信息）。 */
function normalizeError(error) {
  const name = error && error.name ? String(error.name) : '';
  const raw = error && error.message ? String(error.message) : String(error ?? '');
  const lower = raw.toLowerCase();
  if (name === 'TimeoutError' || lower.includes('timeout') || lower.includes('timed out')) {
    return { code: 'timeout', message: '请求网易云接口超时（宿主 10 秒上限），请稍后重试。' };
  }
  if (name === 'AbortError' || lower.includes('aborted') || lower.includes('abort')) {
    return { code: 'aborted', message: '请求网易云接口被中止（信号取消），请重试。' };
  }
  return { code: 'unreachable', message: '无法访问网易云接口（网络不可达或被宿主网络守卫拒绝），请检查网络后重试。' };
}

/** 非 2xx / 业务错误码 → 统一失败对象。 */
function httpFailure(status) {
  return {
    ok: false,
    code: `http-${status}`,
    message: `网易云接口返回 HTTP ${status}，可能是接口临时不可用或被限流，请稍后重试。`,
  };
}

function apiCodeFailure(code) {
  return {
    ok: false,
    code: `api-${code}`,
    message: `网易云接口返回业务错误码 ${code}，请稍后重试。`,
  };
}

// ── 客户端（fetchImpl 注入：context.network.fetch） ───────────────────────────

/**
 * 创建网易云公开 API 客户端。
 * @param {{ fetchImpl: (url: string, init?: object) => Promise<Response> }} options
 */
function createClient({ fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('createClient 需要 fetchImpl（context.network.fetch）');

  /** GET + JSON 解析；失败返回 { ok:false, code, message }。
   *  超时双保险：即便宿主 fetch 实现未自带超时，这里也用 Promise.race 兜底，
   *  避免网络悬挂导致同步流程永久 pending。 */
  async function getJson(url) {
    let response;
    let timer;
    try {
      response = await Promise.race([
        fetchImpl(url, { headers: { ...DEFAULT_HEADERS } }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error('请求网易云接口超时（客户端兜底 10 秒）。');
            err.name = 'TimeoutError';
            reject(err);
          }, CLIENT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      return { ok: false, ...normalizeError(error) };
    } finally {
      clearTimeout(timer);
    }
    const status = response && typeof response.status === 'number' ? response.status : 0;
    if (status < 200 || status >= 300) return httpFailure(status || 0);
    let payload;
    try {
      const text = typeof response.text === 'function' ? await response.text() : '';
      if (!text) return { ok: false, code: 'empty-response', message: '网易云接口返回了空响应体，请稍后重试。' };
      payload = JSON.parse(text);
    } catch {
      return { ok: false, code: 'bad-json', message: '网易云接口返回了无法解析的数据（非 JSON），请稍后重试。' };
    }
    if (payload && typeof payload === 'object' && 'code' in payload) {
      const code = payload.code;
      // 数字比较：上游若返回字符串 "200" 也不应误判为业务失败。
      if (Number(code) !== 200) return apiCodeFailure(code);
    }
    return { ok: true, data: payload };
  }

  return {
    /** 排行榜/歌单详情。 */
    async fetchPlaylistDetail(playlistId) {
      const id = isPositiveInt(playlistId);
      if (id === null) return { ok: false, code: 'bad-param', message: `榜单 id 无效（${String(playlistId)}），需为正整数。` };
      const res = await getJson(`https://music.163.com/api/playlist/detail?id=${id}&n=500`);
      if (!res.ok) return res;
      const playlist = normalizePlaylistPayload(res.data);
      if (!playlist) return { ok: false, code: 'bad-shape', message: '网易云歌单详情响应结构异常（缺少歌单数据），请稍后重试。' };
      return { ok: true, data: playlist };
    },

    /** 歌曲搜索。 */
    async searchSongs(keyword, limit = 20) {
      const kw = typeof keyword === 'string' ? keyword.trim() : '';
      if (!kw) return { ok: false, code: 'bad-param', message: '搜索关键词不能为空。' };
      const n = isPositiveInt(limit) ?? 20;
      const safeLimit = Math.min(50, Math.max(1, n));
      const res = await getJson(`https://music.163.com/api/search/get/web?kw=${encodeURIComponent(kw)}&type=1&limit=${safeLimit}`);
      if (!res.ok) return res;
      return { ok: true, data: normalizeSearchPayload(res.data) };
    },

    /** 歌词（lrc + 可选翻译）。 */
    async fetchLyric(songId) {
      const id = isPositiveInt(songId);
      if (id === null) return { ok: false, code: 'bad-param', message: `歌曲 id 无效（${String(songId)}），需为正整数。` };
      const res = await getJson(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`);
      if (!res.ok) return res;
      return { ok: true, data: normalizeLyricPayload(res.data) };
    },

    /** 每日推荐（登录态接口，v0.1 明确不可用）。 */
    async getDailyRecommendSongs() {
      return { ok: false, code: 'auth-required', message: AUTH_REQUIRED_MESSAGE };
    },

    /** 我的歌单（登录态接口，v0.1 明确不可用）。 */
    async getUserPlaylists() {
      return { ok: false, code: 'auth-required', message: AUTH_REQUIRED_MESSAGE };
    },
  };
}

module.exports = {
  OFFICIAL_CHART_IDS,
  CHART_NAMES,
  DEFAULT_HEADERS,
  AUTH_REQUIRED_MESSAGE,
  isPositiveInt,
  normalizeTrack,
  normalizePlaylistPayload,
  normalizeSearchPayload,
  normalizeLyricPayload,
  normalizeError,
  createClient,
};
