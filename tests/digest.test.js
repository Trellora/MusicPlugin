/**
 * tests/digest.test.js —— lib/digest.js 的摘要聚合纯函数测试。
 * 运行：node --test plugins/yesplay-music/tests
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDigest, truncate, TITLE_MAX, DESCRIPTION_MAX } = require('../lib/digest');

function makeSongs(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `歌名${i + 1}`,
    artists: [`歌手${i + 1}`],
    album: `专辑${i + 1}`,
    durationMs: 200000,
  }));
}

test('逐行格式：序号. 歌手 - 歌名（专辑）', () => {
  const { title, description, count } = buildDigest(
    [{ name: '晴天', artists: ['周杰伦'], album: '叶惠美', durationMs: 269000 }],
    { chartName: '新歌榜' },
  );
  assert.equal(title, '今日榜单速览 · 新歌榜');
  assert.equal(description, '1. 周杰伦 - 晴天（叶惠美）');
  assert.equal(count, 1);
});

test('limit 截取：只列入前 limit 首', () => {
  const { description, count } = buildDigest(makeSongs(30), { chartName: '热歌榜', limit: 5 });
  assert.equal(count, 5);
  assert.ok(description.includes('5. 歌手5 - 歌名5'));
  assert.ok(!description.includes('6. '));
});

test('超长标题截断：≤200 字符且以省略标记收尾', () => {
  const longName = '超'.repeat(300);
  const { title } = buildDigest([], { chartName: longName });
  assert.ok(title.length <= TITLE_MAX);
  assert.ok(title.endsWith('…'));
});

test('超长描述截断：≤4000 字符且留省略标记（含省略首数）', () => {
  const songs = makeSongs(100).map((s, i) => ({
    ...s,
    name: `歌名${i + 1}-${'长'.repeat(80)}`,
  }));
  const { description } = buildDigest(songs, { chartName: '飙升榜', limit: 100 });
  assert.ok(description.length <= DESCRIPTION_MAX);
  assert.ok(description.includes('…'));
  assert.ok(/已省略 \d+ 首/.test(description));
});

test('空列表：count=0 且描述为可读占位文案', () => {
  const { title, description, count } = buildDigest([], { chartName: '原创榜' });
  assert.equal(count, 0);
  assert.equal(title, '今日榜单速览 · 原创榜');
  assert.equal(description, '（榜单为空，暂无歌曲可展示）');
});

test('异常输入稳健：null / 非数组 / 字段缺失不抛异常', () => {
  const r1 = buildDigest(null, { chartName: 'X' });
  assert.equal(r1.count, 0);
  const r2 = buildDigest('不是数组', {});
  assert.equal(r2.count, 0);
  const r3 = buildDigest([{ name: '只有名字' }, null, '字符串项'], {});
  assert.equal(r3.count, 1);
  assert.ok(r3.description.includes('未知歌手 - 只有名字'));
});

test('歌手归一：字符串 / 数组 / {name} 对象混合', () => {
  const { description } = buildDigest([
    { name: 'A', artists: '独唱', album: '' },
    { name: 'B', artists: [{ name: '甲' }, { name: '乙' }], album: { name: '专辑B' } },
    { name: 'C', artists: ['丙', '丁'], album: null },
  ]);
  assert.ok(description.includes('1. 独唱 - A'));
  assert.ok(description.includes('2. 甲/乙 - B（专辑B）'));
  assert.ok(description.includes('3. 丙/丁 - C'));
});

test('truncate 纯函数：短串原样，长串收尾省略标记', () => {
  assert.equal(truncate('短', 10), '短');
  assert.equal(truncate('长'.repeat(20), 10).length, 10);
  assert.ok(truncate('长'.repeat(20), 10).endsWith('…'));
});
