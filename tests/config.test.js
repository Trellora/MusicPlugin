/**
 * tests/config.test.js —— lib/config.js 的配置归一化纯函数测试。
 * 运行：node --test plugins/yesplay-music/tests
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS, normalizeConfig, configSummary, OFFICIAL_CHART_IDS } = require('../lib/config');

test('默认值：官方四榜 + maxSongs 20 + TTL 6 小时 + autoSync 关', () => {
  assert.deepEqual(DEFAULTS.chartIds, [19723756, 3779629, 3778678, 2884035]);
  assert.deepEqual(DEFAULTS.chartIds, [...OFFICIAL_CHART_IDS]);
  assert.equal(DEFAULTS.maxSongs, 20);
  assert.equal(DEFAULTS.cacheTtlHours, 6);
  assert.equal(DEFAULTS.autoSync, false);
});

test('合法配置合并：部分覆盖生效且无警告', () => {
  const { config, warnings } = normalizeConfig({ chartIds: [3779629], maxSongs: 5, autoSync: true });
  assert.deepEqual(config.chartIds, [3779629]);
  assert.equal(config.maxSongs, 5);
  assert.equal(config.autoSync, true);
  assert.equal(config.cacheTtlHours, 6); // 未覆盖项保留默认
  assert.equal(warnings.length, 0);
});

test('maxSongs 越界收敛：500 → 100，0 → 1；非数字回退默认并警告', () => {
  const high = normalizeConfig({ maxSongs: 500 });
  assert.equal(high.config.maxSongs, 100);
  assert.ok(high.warnings.length > 0);

  const low = normalizeConfig({ maxSongs: 0 });
  assert.equal(low.config.maxSongs, 1);

  const bad = normalizeConfig({ maxSongs: '很多' });
  assert.equal(bad.config.maxSongs, DEFAULTS.maxSongs);
  assert.ok(bad.warnings.length > 0);
});

test('非法 chartIds 回退默认：空数组 / 字符串 / 全非数字', () => {
  const empty = normalizeConfig({ chartIds: [] });
  assert.deepEqual(empty.config.chartIds, [...DEFAULTS.chartIds]);
  assert.ok(empty.warnings.length > 0);

  const str = normalizeConfig({ chartIds: 'hot' });
  assert.deepEqual(str.config.chartIds, [...DEFAULTS.chartIds]);

  const junk = normalizeConfig({ chartIds: ['x', null] });
  assert.deepEqual(junk.config.chartIds, [...DEFAULTS.chartIds]);

  // 去重 + 字符串数字容错
  const dup = normalizeConfig({ chartIds: ['3779629', 3779629, 2884035] });
  assert.deepEqual(dup.config.chartIds, [3779629, 2884035]);
});

test('cacheTtlHours 边界：0 → 0.1，9999 → 168，非数字回退默认', () => {
  assert.equal(normalizeConfig({ cacheTtlHours: 0 }).config.cacheTtlHours, 0.1);
  assert.equal(normalizeConfig({ cacheTtlHours: 9999 }).config.cacheTtlHours, 168);
  const bad = normalizeConfig({ cacheTtlHours: '很久' });
  assert.equal(bad.config.cacheTtlHours, DEFAULTS.cacheTtlHours);
  assert.ok(bad.warnings.length > 0);
});

test('autoSync 非布尔回退原值；非法整体输入（null）不抛异常', () => {
  const bad = normalizeConfig({ autoSync: 'yes' });
  assert.equal(bad.config.autoSync, DEFAULTS.autoSync);

  const none = normalizeConfig(null);
  assert.deepEqual(none.config.chartIds, [...DEFAULTS.chartIds]);
  assert.equal(none.warnings.length, 0);
});

test('configSummary 不含敏感字段（本插件无凭据）且可序列化', () => {
  const summary = configSummary(DEFAULTS);
  const keys = Object.keys(summary);
  assert.ok(keys.includes('chartIds'));
  assert.ok(keys.includes('maxSongs'));
  assert.ok(keys.includes('cacheTtlHours'));
  assert.ok(keys.includes('autoSync'));
  assert.equal(keys.some((k) => /token|secret|password|key/i.test(k)), false);
  assert.doesNotThrow(() => JSON.stringify(summary));
});
