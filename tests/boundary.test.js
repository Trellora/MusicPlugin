/**
 * tests/boundary.test.js —— cache / config / digest / lyrics 的边界与修复回归测试。
 * 运行：node --test plugins/yesplay-music/tests
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeKey, stableStringify, fnv1aHex, createCache } = require('../lib/cache');
const { normalizeConfig, normalizeChartIds } = require('../lib/config');
const { truncate } = require('../lib/digest');
const { fracToMs, tagToMs } = require('../lib/lyrics');

/** 内存假 context.files（与 cache.test.js 的 makeFakeFiles() 同构，不碰磁盘）。 */
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

// ── cache.js 边界 ────────────────────────────────────────────────────────────

test('cache.set 非法 ttlMs（"abc" / NaN / -1 / Infinity）以 TypeError 拒绝', async () => {
  const cache = createCache(makeFakeFiles());
  for (const badTtl of ['abc', NaN, -1, Infinity]) {
    await assert.rejects(
      () => cache.set('k', 1, badTtl),
      TypeError,
      `ttlMs=${String(badTtl)} 应拒绝`,
    );
  }
});

test('并发 set 不丢写：Promise.all 5 个 set 后 stats().total === 5', async () => {
  const cache = createCache(makeFakeFiles());
  await Promise.all([1, 2, 3, 4, 5].map((i) => cache.set(`k${i}`, i, 1000)));
  const stats = await cache.stats();
  assert.equal(stats.total, 5);
});

test('fnv1aHex 对 emoji 与非 BMP 字符稳定可复现', () => {
  const emoji = '😀';
  const nonBmp = '\u{1F600}\u{1D400}'; // 含代理对与非 BMP 字母
  assert.equal(fnv1aHex(emoji), fnv1aHex(emoji));
  assert.match(fnv1aHex(emoji), /^[0-9a-f]{8}$/);
  assert.match(fnv1aHex(nonBmp), /^[0-9a-f]{8}$/);
  assert.equal(fnv1aHex(nonBmp), fnv1aHex('\u{1F600}\u{1D400}'));
  assert.notEqual(fnv1aHex(emoji), fnv1aHex(nonBmp));
  // 不同输入不同键（避免缓存投毒）
  assert.notEqual(fnv1aHex('😀'), fnv1aHex('😁'));
});

test('stableStringify 对循环引用抛 TypeError（不静默产出错误键）', () => {
  const a = {};
  a.self = a;
  assert.throws(() => stableStringify(a), TypeError);
});

test('stableStringify：{a:undefined} 与 {a:null} 严格区分（不同缓存键）', () => {
  assert.notEqual(stableStringify({ a: undefined }), stableStringify({ a: null }));
  assert.equal(stableStringify({ a: undefined }), '{"a":undefined}');
  assert.equal(stableStringify({ a: null }), '{"a":null}');
  // makeKey 同样区分（键不同 → 不互相覆盖）
  assert.notEqual(makeKey('x', { a: undefined }), makeKey('x', { a: null }));
});

// ── config.js 边界 ───────────────────────────────────────────────────────────

test('maxSongs 整数收敛修复：1.4 → 1，99.6 → 100（先取整再钳制）', () => {
  assert.equal(normalizeConfig({ maxSongs: 1.4 }).config.maxSongs, 1);
  assert.equal(normalizeConfig({ maxSongs: 99.6 }).config.maxSongs, 100);
});

test('chartIds 超过 20 个截断为 20（保留前 20 个有效正整数）', () => {
  const big = Array.from({ length: 25 }, (_, i) => 1000 + i);
  const { config } = normalizeConfig({ chartIds: big });
  assert.equal(config.chartIds.length, 20);
  assert.deepEqual(config.chartIds, big.slice(0, 20));
});

test('normalizeChartIds 纯函数：去重、截断、非法项过滤', () => {
  assert.deepEqual(normalizeChartIds([3, 1, 3, 2]), [3, 1, 2]);
  assert.equal(normalizeChartIds(Array.from({ length: 30 }, (_, i) => i + 1)).length, 20);
  assert.equal(normalizeChartIds([0, -1, 'x']), null); // 无有效 id → null
});

// ── digest.js 边界 ───────────────────────────────────────────────────────────

test('truncate 边界修复：limit ≤ 0 返回空串（不产生超限字符）', () => {
  assert.equal(truncate('长'.repeat(20), 0), '');
  assert.equal(truncate('abc', -5), '');
  // 对照：正 limit 正常截断并留省略标记
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'ab…');
});

// ── lyrics.js 边界 ───────────────────────────────────────────────────────────

test('fracToMs 小数秒语义修复：4 位小数按定点小数解释并四舍五入', () => {
  // '1234' 表示 0.1234 秒 → 123ms（毫秒级取整）
  assert.equal(fracToMs('1234'), 123);
  // '9995' 表示 0.9995 秒 → 1000ms（四舍五入进位）
  assert.equal(fracToMs('9995'), 1000);
});

test('fracToMs 常规位数：1/2/3 位按十分/百分/千分之几秒放大', () => {
  assert.equal(fracToMs('5'), 500);
  assert.equal(fracToMs('50'), 500);
  assert.equal(fracToMs('500'), 500);
  assert.equal(fracToMs(''), 0);
});

test('tagToMs 叠加 fracToMs 的进位：01:02.1234 → 62123ms', () => {
  assert.equal(tagToMs('1', '2', '1234'), 1 * 60 * 1000 + 2 * 1000 + 123);
  assert.equal(tagToMs('0', '0', '9995'), 1000); // 进位到 1000ms
});
