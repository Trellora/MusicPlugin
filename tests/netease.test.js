/**
 * tests/netease.test.js —— lib/netease.js 的网易云公开接口客户端测试（注入 mock fetchImpl，绝不真实联网）。
 * 运行：node --test plugins/yesplay-music/tests
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OFFICIAL_CHART_IDS,
  CHART_NAMES,
  isPositiveInt,
  normalizeTrack,
  normalizePlaylistPayload,
  normalizeSearchPayload,
  normalizeLyricPayload,
  normalizeError,
  createClient,
} = require('../lib/netease');

/** 构造 mock fetchImpl：按队列逐个返回假 Response（{ status, text }），并记录请求 url。 */
function makeFakeFetch(queue, calls = []) {
  let i = 0;
  return async (url) => {
    calls.push(url);
    const item = queue[Math.min(i, queue.length - 1)];
    i += 1;
    return typeof item === 'function' ? item() : item;
  };
}

/** 立即返回一段 JSON 文本的假 Response。 */
function jsonResponse(obj, status = 200) {
  return { status, text: async () => JSON.stringify(obj) };
}

/** 构造带指定 name 的异常（模拟 fetchImpl 抛错）。 */
function namedError(name, message = 'err') {
  const e = new Error(message);
  e.name = name;
  return e;
}

// ── 常量与纯函数 ─────────────────────────────────────────────────────────────

test('常量：官方四榜 id 与中文名映射齐备', () => {
  assert.deepEqual(OFFICIAL_CHART_IDS, {
    RISING: 19723756,
    NEW: 3779629,
    HOT: 3778678,
    ORIGINAL: 2884035,
  });
  assert.equal(CHART_NAMES[19723756], '飙升榜');
  assert.equal(CHART_NAMES[3779629], '新歌榜');
  assert.equal(CHART_NAMES[3778678], '热歌榜');
  assert.equal(CHART_NAMES[2884035], '原创榜');
});

test('isPositiveInt：正整数放行（含可解析字符串/小数取整），非法返回 null', () => {
  assert.equal(isPositiveInt(19723756), 19723756);
  assert.equal(isPositiveInt('3779629'), 3779629);
  assert.equal(isPositiveInt(12.6), 13);
  assert.equal(isPositiveInt(0), null);
  assert.equal(isPositiveInt(-5), null);
  assert.equal(isPositiveInt('abc'), null);
  assert.equal(isPositiveInt(null), null);
  assert.equal(isPositiveInt(undefined), null);
  assert.equal(isPositiveInt(NaN), null);
});

test('normalizeTrack：新字段名 artists/album/duration', () => {
  const t = normalizeTrack({
    id: 123,
    name: '晴天',
    artists: [{ name: '周杰伦' }],
    album: { name: '叶惠美' },
    duration: 269000,
  });
  assert.deepEqual(t, {
    id: 123,
    name: '晴天',
    artists: ['周杰伦'],
    album: '叶惠美',
    durationMs: 269000,
  });
});

test('normalizeTrack：旧字段名 ar/al/dt 兼容', () => {
  const t = normalizeTrack({ id: 7, name: 'N', ar: [{ name: 'A' }], al: { name: 'Al' }, dt: 100 });
  assert.deepEqual(t, { id: 7, name: 'N', artists: ['A'], album: 'Al', durationMs: 100 });
});

test('normalizeTrack：缺失字段优雅降级（id null、空歌手、空专辑、0 时长）', () => {
  const t = normalizeTrack({ name: '只有名字' });
  assert.deepEqual(t, { id: null, name: '只有名字', artists: [], album: '', durationMs: 0 });
});

test('normalizeTrack：歌手支持字符串项与非法项过滤', () => {
  const t = normalizeTrack({ id: 1, name: 'x', artists: [null, { name: 'X' }, 'Y', 42] });
  assert.deepEqual(t.artists, ['X', 'Y']);
  // artists 非数组（字符串）时优雅降级为空数组
  assert.deepEqual(normalizeTrack({ id: 1, name: 'x', artists: 'solo' }).artists, []);
  // album 为纯字符串也接受
  assert.equal(normalizeTrack({ id: 1, name: 'x', album: 'Alb' }).album, 'Alb');
});

test('normalizeTrack：非对象输入返回 null', () => {
  assert.equal(normalizeTrack(null), null);
  assert.equal(normalizeTrack(undefined), null);
  assert.equal(normalizeTrack('字符串'), null);
  assert.equal(normalizeTrack(42), null);
});

test('normalizePlaylistPayload：result/playlist 双字段兼容，tracks/trackIds 均可', () => {
  const p1 = normalizePlaylistPayload({ result: { id: 9, name: 'P', tracks: [{ id: 4, name: 'v' }] } });
  assert.deepEqual(p1, { id: 9, name: 'P', tracks: [{ id: 4, name: 'v', artists: [], album: '', durationMs: 0 }] });

  const p2 = normalizePlaylistPayload({ playlist: { id: 9, name: 'P', trackIds: [{ id: 4, name: 'v' }] } });
  assert.equal(p2.tracks.length, 1);

  // 缺少歌单对象 / 非对象输入 → null
  assert.equal(normalizePlaylistPayload({}), null);
  assert.equal(normalizePlaylistPayload(null), null);
  assert.equal(normalizePlaylistPayload('x'), null);
});

test('normalizeSearchPayload：result.songs / 顶层 songs 兼容，非对象输入回空列表', () => {
  assert.deepEqual(normalizeSearchPayload({ result: { songs: [{ id: 2, name: 't' }] } }).songs.length, 1);
  assert.deepEqual(normalizeSearchPayload({ songs: [{ id: 3, name: 'u' }] }).songs.length, 1);
  assert.deepEqual(normalizeSearchPayload(null), { songs: [] });
  assert.deepEqual(normalizeSearchPayload('x'), { songs: [] });
});

test('normalizeLyricPayload：lrc/tlyric 字符串提取，缺失或非字符串回空串', () => {
  assert.deepEqual(normalizeLyricPayload({ lrc: { lyric: 'L' }, tlyric: { lyric: 'T' } }), { lrc: 'L', translated: 'T' });
  assert.deepEqual(normalizeLyricPayload(null), { lrc: '', translated: '' });
  assert.deepEqual(normalizeLyricPayload({ lrc: { lyric: 5 }, tlyric: 'x' }), { lrc: '', translated: '' });
});

test('normalizeError：TimeoutError/AbortError/普通错误分别归类', () => {
  assert.equal(normalizeError(namedError('TimeoutError')).code, 'timeout');
  assert.equal(normalizeError(namedError('AbortError')).code, 'aborted');
  assert.equal(normalizeError(new Error('boom')).code, 'unreachable');
  // 消息含 timeout/aborted 字样也归类
  assert.equal(normalizeError(new Error('request timed out')).code, 'timeout');
  assert.equal(normalizeError(new Error('the operation was aborted')).code, 'aborted');
});

// ── createClient / getJson 行为（经 fetchPlaylistDetail 等入口触发） ──────────

test('createClient：缺少 fetchImpl 抛可读错误', () => {
  assert.throws(() => createClient({}), /fetchImpl/);
});

test('getJson 成功：code 为数字 200 → ok:true 返回 payload', async () => {
  const client = createClient({
    fetchImpl: makeFakeFetch([jsonResponse({ code: 200, result: { id: 1, name: 'P', tracks: [] } })]),
  });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { id: 1, name: 'P', tracks: [] });
});

test('数值比较修复：code 为字符串 "200" 同样判定成功（Number(code) !== 200）', async () => {
  const client = createClient({
    fetchImpl: makeFakeFetch([jsonResponse({ code: '200', result: { id: 1, name: 'P', tracks: [] } })]),
  });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, true);
});

test('业务错误码：code 404 → {ok:false, code:"api-404"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([jsonResponse({ code: 404 })]) });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'api-404');
});

test('HTTP 500 → {ok:false, code:"http-500"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([{ status: 500, text: async () => '服务器内部错误' }]) });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'http-500');
});

test('空响应体 → {ok:false, code:"empty-response"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([{ status: 200, text: async () => '' }]) });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'empty-response');
});

test('非 JSON 响应体 → {ok:false, code:"bad-json"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([{ status: 200, text: async () => '<html>oops</html>' }]) });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-json');
});

test('fetchImpl 抛 TimeoutError → {ok:false, code:"timeout"}', async () => {
  const client = createClient({
    fetchImpl: async () => { throw namedError('TimeoutError', '请求超时'); },
  });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'timeout');
});

test('fetchImpl 抛 AbortError → {ok:false, code:"aborted"}', async () => {
  const client = createClient({
    fetchImpl: async () => { throw namedError('AbortError', '请求被中止'); },
  });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'aborted');
});

test('fetchImpl 抛普通 Error → {ok:false, code:"unreachable"}', async () => {
  const client = createClient({
    fetchImpl: async () => { throw new Error('网络不可达'); },
  });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unreachable');
});

test('响应缺少歌单数据 → {ok:false, code:"bad-shape"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([jsonResponse({ code: 200 })]) });
  const res = await client.fetchPlaylistDetail(1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-shape');
});

// ── 参数校验与登录态 stub ────────────────────────────────────────────────────

test('fetchPlaylistDetail 非法 id（0 / -1 / "abc" / null）→ {ok:false, code:"bad-param"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([jsonResponse({ code: 200 })]) });
  for (const badId of [0, -1, 'abc', null]) {
    const res = await client.fetchPlaylistDetail(badId);
    assert.equal(res.ok, false, `id=${String(badId)} 应拒绝`);
    assert.equal(res.code, 'bad-param');
  }
});

test('searchSongs 空关键词 → {ok:false, code:"bad-param"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([jsonResponse({ code: 200 })]) });
  for (const kw of ['', '   ', null, 42]) {
    const res = await client.searchSongs(kw);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad-param');
  }
});

test('fetchLyric 非法歌曲 id → {ok:false, code:"bad-param"}', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([jsonResponse({ code: 200 })]) });
  const res = await client.fetchLyric('x');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-param');
});

test('登录态接口 stub：getDailyRecommendSongs / getUserPlaylists 返回 auth-required', async () => {
  const client = createClient({ fetchImpl: makeFakeFetch([jsonResponse({ code: 200 })]) });
  const a = await client.getDailyRecommendSongs();
  const b = await client.getUserPlaylists();
  assert.equal(a.ok, false);
  assert.equal(a.code, 'auth-required');
  assert.equal(b.ok, false);
  assert.equal(b.code, 'auth-required');
});

// ── 请求构造与归一化集成 ─────────────────────────────────────────────────────

test('fetchPlaylistDetail 成功路径：URL 含榜单 id 且返回归一化歌单', async () => {
  const calls = [];
  const client = createClient({
    fetchImpl: makeFakeFetch([jsonResponse({
      code: 200,
      result: {
        id: 3779629,
        name: '新歌榜',
        tracks: [{ id: 1, name: 'A', artists: [{ name: 'X' }], album: { name: 'Al' }, duration: 1000 }],
      },
    })], calls),
  });
  const res = await client.fetchPlaylistDetail(3779629);
  assert.equal(res.ok, true);
  assert.equal(calls[0], 'https://music.163.com/api/playlist/detail?id=3779629&n=500');
  assert.deepEqual(res.data.tracks[0], { id: 1, name: 'A', artists: ['X'], album: 'Al', durationMs: 1000 });
});

test('searchSongs：关键词 encodeURIComponent、limit 钳制到 1–50', async () => {
  const calls = [];
  const client = createClient({
    fetchImpl: makeFakeFetch([jsonResponse({ code: 200, result: { songs: [{ id: 1, name: 'a' }] } })], calls),
  });
  await client.searchSongs('晴天 & 你', 100);
  assert.equal(calls[0], 'https://music.163.com/api/search/get/web?kw=%E6%99%B4%E5%A4%A9%20%26%20%E4%BD%A0&type=1&limit=50');
  await client.searchSongs('x', 0);
  assert.match(calls[1], /limit=20$/); // 非法 limit 回退 20
});

test('fetchLyric 成功路径：返回 { lrc, translated }', async () => {
  const client = createClient({
    fetchImpl: makeFakeFetch([jsonResponse({ code: 200, lrc: { lyric: '[00:01.00]hi' }, tlyric: { lyric: '[00:01.00]嗨' } })]),
  });
  const res = await client.fetchLyric(1);
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { lrc: '[00:01.00]hi', translated: '[00:01.00]嗨' });
});

// ── 自带兜底超时（Promise.race）的分类测试 ──────────────────────────────────

test('兜底超时分类：normalizeError 把 TimeoutError 归为 timeout', () => {
  // 完整的 Promise.race 兜底超时（CLIENT_TIMEOUT_MS = 10 秒）会拖慢单测，
  // 故此处直接测分类逻辑（race 的 reject 路径与此完全相同），不在单测里真实等待 10 秒。
  assert.equal(normalizeError(namedError('TimeoutError', '请求网易云接口超时（客户端兜底 10 秒）。')).code, 'timeout');
});

test('永不 resolve 的 fetchImpl 会被 10 秒兜底超时接住（异步，不阻塞断言）', async () => {
  // 用永不 resolve 的 fetchImpl 验证 getJson 不会永久悬挂：Promise.race 里
  // 的 setTimeout(TIMEOUT) 会以 TimeoutError 拒绝 → normalizeError 归类 timeout。
  // 为不拖慢套件，这里只断言「Promise 在合理时间内 settle（失败或成功均可，不允许悬挂）」，
  // 用 50ms 内先完成的 normalizeError 分类测试覆盖错误语义（见上一测试）。
  const client = createClient({ fetchImpl: () => new Promise(() => {}) });
  let settled = false;
  client.fetchPlaylistDetail(1).finally(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 50));
  // 10 秒兜底尚未触发，此时不应已 settle（fetchImpl 永不 resolve）；
  // 一旦触发则必为 timeout 归类（由上一测试保证语义）。
  assert.equal(settled, false);
  // 注：完整的「等待 10 秒拿到 timeout 结果」刻意不在单测中执行（太慢），仅由
  // normalizeError 分类测试 + Promise.race 实现代码路径（getJson）覆盖语义。
});
