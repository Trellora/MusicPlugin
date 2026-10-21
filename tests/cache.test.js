/**
 * tests/cache.test.js —— lib/cache.js 的缓存键与 TTL 判定测试（用内存假 files，不碰磁盘）。
 * 运行：node --test plugins/yesplay-music/tests
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeKey, stableStringify, fnv1aHex, isExpired, createCache, CACHE_FILE } = require('../lib/cache');

/** 内存假 context.files（readFile/writeFile 语义一致）。 */
function makeFakeFiles() {
  const store = new Map();
  return {
    store,
    async readFile(path) {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      return store.get(path);
    },
    async writeFile(path, data) {
      store.set(path, data);
    },
  };
}

test('缓存键：同参数稳定、不同参数不同键、参数顺序无关', () => {
  const a = makeKey('playlist-detail', { id: 19723756, n: 500 });
  const b = makeKey('playlist-detail', { id: 19723756, n: 500 });
  const c = makeKey('playlist-detail', { id: 3779629, n: 500 });
  const d = makeKey('playlist-detail', { n: 500, id: 19723756 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a, d); // 键顺序不影响哈希
  assert.ok(a.startsWith('playlist-detail:'));
  assert.ok(/^playlist-detail:[0-9a-f]{8}$/.test(a));
});

test('稳定序列化与哈希：纯函数可复现', () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
  assert.equal(fnv1aHex('abc'), fnv1aHex('abc'));
  assert.match(fnv1aHex('abc'), /^[0-9a-f]{8}$/);
});

test('TTL 判定：新鲜不判过期、超期判过期、缺省/非法判过期', () => {
  const now = 1_000_000;
  const entry = { savedAt: new Date(now).toISOString(), ttlMs: 500, data: 1 };
  assert.equal(isExpired(entry, now + 100), false);
  assert.equal(isExpired(entry, now + 500), false); // 恰好到期未超
  assert.equal(isExpired(entry, now + 501), true);
  assert.equal(isExpired(null, now), true);
  assert.equal(isExpired({}, now), true);
  assert.equal(isExpired({ savedAt: '坏时间', ttlMs: 500 }, now), true);
  assert.equal(isExpired({ savedAt: new Date(now).toISOString(), ttlMs: -1 }, now), true);
});

test('createCache 读写往返：set → get 命中；TTL 过期后 get 返回 null', async () => {
  const files = makeFakeFiles();
  const cache = createCache(files);
  const key = makeKey('search', { kw: '晴天', limit: 20 });

  assert.equal(await cache.get(key), null); // 冷启动未命中

  const now = 2_000_000;
  await cache.set(key, { songs: [1, 2, 3] }, 1000, now);
  assert.deepEqual(await cache.get(key, now + 500), { songs: [1, 2, 3] });
  assert.equal(await cache.get(key, now + 5000), null); // TTL 过期 → null

  // 只经 files 读写：缓存文件路径固定、内容为 JSON
  const doc = JSON.parse(new TextDecoder().decode(files.store.get(CACHE_FILE)));
  assert.equal(doc.version, 1);
});

test('clear 与 stats：清空后条目归零，统计区分新鲜/过期', async () => {
  const files = makeFakeFiles();
  const cache = createCache(files);
  const now = 3_000_000;

  await cache.set(makeKey('a', { x: 1 }), 'A', 1000, now);
  await cache.set(makeKey('b', { x: 2 }), 'B', 1000, now - 5000); // 写入即过期

  const stats = await cache.stats(now);
  assert.equal(stats.total, 2);
  assert.equal(stats.fresh, 1);
  assert.equal(stats.stale, 1);

  await cache.clear();
  const after = await cache.stats(now);
  assert.equal(after.total, 0);
  assert.equal(await cache.get(makeKey('a', { x: 1 }), now), null);
});
